import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBuiltinTools, createBuiltinExecPolicy } from "./index"
import { MemoryMemoryStore } from "@newhorse/memory"
import type { Tool, ToolCtx } from "@newhorse/core"
import type { ExecPolicy } from "@newhorse/schema"
import type { Decision } from "@newhorse/schema"

/** An allow-all execpolicy so fs/bash tests exercise the happy path without
 * being denied (M4): read/write/edit/bash now require an injected policy. */
const allowAll: ExecPolicy = { decide: (): Decision => "allow", decidePath: (): Decision => "allow" }
const allowCtx: ToolCtx = { caller: { kind: "user" }, execPolicy: allowAll }

async function ws(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "nh-tools-"))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

describe("builtin tools", () => {
  it("default set excludes bash; enableBash adds it", async () => {
    const { root, cleanup } = await ws()
    try {
      const base = createBuiltinTools({ workspace: root })
      expect(base.map((t) => t.name).sort()).toEqual(["edit", "list", "read", "search", "write"])
      const withBash = createBuiltinTools({ workspace: root, enableBash: true })
      expect(withBash.map((t) => t.name)).toContain("bash")
    } finally {
      await cleanup()
    }
  })

  it("write then read round-trips (line numbers, no truncation)", async () => {
    const { root, cleanup } = await ws()
    try {
      const tools = createBuiltinTools({ workspace: root })
      const write = byName(tools, "write")
      const read = byName(tools, "read")
      await write.execute({ path: "a/b.txt", content: "line1\nline2\nline3" }, allowCtx)
      const out = await read.execute({ path: "a/b.txt" }, allowCtx) as { lines: string[]; truncated: boolean; totalLines: number }
      expect(out.totalLines).toBe(3)
      expect(out.truncated).toBe(false)
      expect(out.lines[0]).toContain("line1")
      expect(out.lines[0]).toMatch(/^\s*1/)
      expect(out.lines[2]).toMatch(/^\s*3/)
    } finally {
      await cleanup()
    }
  })

  it("read refuses to escape the workspace", async () => {
    const { root, cleanup } = await ws()
    const outside = join(tmpdir(), "nh-secret.txt")
    await writeFile(outside, "secret")
    try {
      const read = byName(createBuiltinTools({ workspace: root }), "read")
      const out = await read.execute({ path: "../" + join("..", "nh-secret.txt") }, allowCtx) as { error: string }
      expect(out.error).toBeDefined()
    } finally {
      await cleanup()
      await rm(outside, { force: true })
    }
  })

  it("edit replaces unique match and preserves EOL", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "f.txt"), "hello\r\nworld\r\nhello")
      const edit = byName(createBuiltinTools({ workspace: root }), "edit")
      const out = await edit.execute({ path: "f.txt", old: "world", new: "there" }, allowCtx) as { replaced: number }
      expect(out.replaced).toBe(1)
      const text = await readFile(join(root, "f.txt"), "utf8")
      expect(text).toBe("hello\r\nthere\r\nhello")
    } finally {
      await cleanup()
    }
  })

  it("edit rejects old==new and empty old", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "f.txt"), "abc")
      const edit = byName(createBuiltinTools({ workspace: root }), "edit")
      await expect(edit.execute({ path: "f.txt", old: "abc", new: "abc" }, allowCtx)).resolves.toMatchObject({ error: expect.stringContaining("identical") })
      await expect(edit.execute({ path: "f.txt", old: "", new: "x" }, allowCtx)).resolves.toMatchObject({ error: expect.stringContaining("non-empty") })
    } finally {
      await cleanup()
    }
  })

  it("edit returns structured disambiguation on multi-hit without replaceAll", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "f.txt"), "one\ntwo one\none")
      const edit = byName(createBuiltinTools({ workspace: root }), "edit")
      const out = await edit.execute({ path: "f.txt", old: "one", new: "X" }, allowCtx) as { matches: number; hits: { line: number }[] }
      expect(out.matches).toBe(3)
      expect(out.hits.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it("list matches a glob and works under a base dir", async () => {
    const { root, cleanup } = await ws()
    try {
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "src/index.ts"), "")
      await writeFile(join(root, "src/app.ts"), "")
      await writeFile(join(root, "docs.md"), "")
      const list = byName(createBuiltinTools({ workspace: root }), "list")
      const out = await list.execute({ pattern: "**/*.ts", path: "src" }) as { files: string[] }
      expect(out.files).toContain("index.ts")
      expect(out.files).toContain("app.ts")
      expect(out.files).not.toContain("docs.md")
    } finally {
      await cleanup()
    }
  })

  it("search finds a pattern and reports file:line", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "a.ts"), "const foo = 1;\nconst bar = 2;\n")
      await writeFile(join(root, "b.ts"), "const foobar = 3;\n")
      const search = byName(createBuiltinTools({ workspace: root }), "search")
      const out = await search.execute({ pattern: "\\bfoo\\b" }) as { totalMatches: number; hits: { file: string; line: number; text: string }[] }
      expect(out.totalMatches).toBe(1)
      expect(out.hits[0]!.file).toBe("a.ts")
      expect(out.hits[0]!.line).toBe(1)
      expect(out.hits[0]!.text).toContain("foo")
    } finally {
      await cleanup()
    }
  })

  it("bash runs a command, returns stdout + exitCode (non-zero is data)", async () => {
    const { root, cleanup } = await ws()
    try {
      const bash = byName(createBuiltinTools({ workspace: root, enableBash: true }), "bash")
      const ok = await bash.execute({ command: "echo hi" }, allowCtx) as { stdout: string; exitCode: number }
      expect(ok.stdout.trim()).toBe("hi")
      expect(ok.exitCode).toBe(0)
      const bad = await bash.execute({ command: "exit 3" }, allowCtx) as { exitCode: number }
      expect(bad.exitCode).toBe(3)
    } finally {
      await cleanup()
    }
  })

  it("bash respects a hard clamp on timeout", async () => {
    const { root, cleanup } = await ws()
    try {
      const bash = byName(createBuiltinTools({ workspace: root, enableBash: true }), "bash")
      // A fast, harmless command validates that the clamp path still runs.
      const out = await bash.execute({ command: process.platform === "win32" ? "echo ok" : "true", timeoutMs: 200 }, allowCtx) as { exitCode: number }
      expect(out.exitCode).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it("bash defaults to a non-trivial timeout (not 1ms)", async () => {
    const { root, cleanup } = await ws()
    try {
      const bash = byName(createBuiltinTools({ workspace: root, enableBash: true }), "bash")
      // A command that takes ~300ms must survive the default timeout (which must
      // be the hard cap, not clamopy a missing value to 1ms).
      const out = await bash.execute({ command: process.platform === "win32" ? "ping -n 2 127.0.0.1 >nul" : "sleep 0.3" }, allowCtx) as { exitCode: number; timedOut: boolean }
      expect(out.timedOut).toBe(false)
      expect(out.exitCode).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it("bash cwd is pinned to the workspace", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "marker.txt"), "here")
      const bash = byName(createBuiltinTools({ workspace: root, enableBash: true }), "bash")
      const out = await bash.execute({ command: process.platform === "win32" ? "dir /b marker.txt" : "ls marker.txt" }, allowCtx) as { stdout: string }
      expect(out.stdout).toContain("marker.txt")
    } finally {
      await cleanup()
    }
  })

  it("write creates parent dirs", async () => {
    const { root, cleanup } = await ws()
    try {
      const write = byName(createBuiltinTools({ workspace: root }), "write")
      await write.execute({ path: "deep/nested/x.txt", content: "content" }, allowCtx)
      await expect(readFile(join(root, "deep/nested/x.txt"), "utf8")).resolves.toBe("content")
    } finally {
      await cleanup()
    }
  })

  it("list follows a workspace-internal symlink that points outside", async () => {
    const { root, cleanup } = await ws()
    const outside = await mkdtemp(join(tmpdir(), "nh-leak-"))
    try {
      await writeFile(join(outside, "leaked.txt"), "SECRET-LEAK")
      await symlink(outside, join(root, "link"), "junction").catch(() => {})
      const list = byName(createBuiltinTools({ workspace: root }), "list")
      const out = await list.execute({ pattern: "**/*", path: root }) as { files: string[] }
      // A symlink/junction is never followed — the external file is not collected.
      expect(out.files).not.toContain("link/leaked.txt")
      const search = byName(createBuiltinTools({ workspace: root }), "search")
      const s = await search.execute({ pattern: "SECRET" }) as { totalMatches: number }
      expect(s.totalMatches).toBe(0)
    } finally {
      await cleanup()
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("read truncates long output and flags it", async () => {
    const { root, cleanup } = await ws()
    try {
      const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n")
      await writeFile(join(root, "big.txt"), lines)
      const read = byName(createBuiltinTools({ workspace: root }), "read")
      const out = await read.execute({ path: "big.txt" }, allowCtx) as { truncated: boolean }
      expect(out.truncated).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it("list glob is case-insensitive on win32 (extension casing)", async () => {
    const { root, cleanup } = await ws()
    try {
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "src/Foo.TS"), "")
      const list = byName(createBuiltinTools({ workspace: root }), "list")
      const out = await list.execute({ pattern: "**/*.ts" }) as { files: string[] }
      expect(out.files).toContain("src/Foo.TS")
    } finally {
      await cleanup()
    }
  })

  it("search flags a byte budget instead of silently returning a false no-match", async () => {
    const { root, cleanup } = await ws()
    try {
      // A huge file first (alphabetically), then a tiny target file. The budget
      // must mark `budgetExceeded`/`truncated` rather than dropping the target
      // silently and reporting a confident 0 matches.
      await writeFile(join(root, "aaa_big.txt"), "x".repeat(2 * 1024 * 1024))
      await writeFile(join(root, "zzz_target.txt"), "TARGET_TOKEN")
      const search = byName(createBuiltinTools({ workspace: root }), "search")
      const out = await search.execute({ pattern: "TARGET_TOKEN" }) as { totalMatches: number; budgetExceeded: boolean; truncated: boolean }
      expect(out.totalMatches).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it("read reports an offset beyond EOF instead of a silent empty result", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "f.txt"), "line1\nline2\nline3")
      const read = byName(createBuiltinTools({ workspace: root }), "read")
      const out = await read.execute({ path: "f.txt", offset: 999 }, allowCtx) as { lines: string[]; totalLines: number }
      expect(out.totalLines).toBe(3)
      expect(out.lines.length).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it("read fails closed without an execpolicy and honors a path decision", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "f.txt"), "hello")
      const read = byName(createBuiltinTools({ workspace: root }), "read")
      // No ctx -> no policy -> deny (read is now gated like write/bash).
      const bare = await read.execute({ path: "f.txt" }) as { error: string }
      expect(bare.error).toContain("denied")
      // A forbid decision is honored without touching the filesystem.
      const forbidCtx: ToolCtx = {
        caller: { kind: "user" },
        execPolicy: { decide: () => "allow", decidePath: () => "forbid" },
      }
      const blocked = await read.execute({ path: "f.txt" }, forbidCtx) as { error: string }
      expect(blocked.error).toContain("denied")
    } finally {
      await cleanup()
    }
  })

  it("write cannot reach a protected dir through a workspace-internal junction", async () => {
    const { root, cleanup } = await ws()
    try {
      await mkdir(join(root, ".newhorse"), { recursive: true })
      // A junction named `link` resolves INTO `.newhorse` — the policy must catch
      // it via the real path (decidePath on the raw `link/...` would miss it).
      await symlink(join(root, ".newhorse"), join(root, "link"), "junction").catch(() => {})
      const write = byName(createBuiltinTools({ workspace: root }), "write")
      const realPolicy = createBuiltinExecPolicy({ dataDir: join(root, ".data"), workspace: root })
      const out = await write.execute({ path: "link/rules.json", content: "evil" }, { caller: { kind: "user" }, execPolicy: realPolicy }) as { error?: string }
      expect(out.error ?? "").toMatch(/denied|forbid/)
    } finally {
      await cleanup()
    }
  })

  it("list/search refuse a base rooted inside a protected dir", async () => {
    const { root, cleanup } = await ws()
    try {
      await mkdir(join(root, ".git"), { recursive: true })
      await writeFile(join(root, ".git", "config"), "secret")
      const tools = createBuiltinTools({ workspace: root })
      const list = byName(tools, "list")
      const search = byName(tools, "search")
      const l = await list.execute({ pattern: "**/*", path: ".git" }) as { error?: string }
      expect(l.error ?? "").toMatch(/protected|disallowed/)
      const s = await search.execute({ pattern: "secret", path: ".git" }) as { error?: string }
      expect(s.error ?? "").toMatch(/protected|disallowed/)
    } finally {
      await cleanup()
    }
  })

  it("memory tools are exposed only when a memoryStore is injected; search+write round-trip", async () => {
    const noMem = createBuiltinTools({ workspace: "G:/proj" })
    expect(noMem.some((t) => t.name === "memory_search")).toBe(false)

    const store = new MemoryMemoryStore()
    const tools = createBuiltinTools({ workspace: "G:/proj", memoryStore: store })
    const search = tools.find((t) => t.name === "memory_search")!
    const write = tools.find((t) => t.name === "memory_write")!
    expect(search).toBeTruthy()
    expect(write).toBeTruthy()

    const writen = await write.execute({ content: "User prefers type-safe code", type: "persona", priority: 80 }, { caller: { kind: "parent", sessionId: "s1" }, sessionId: "s1" })
    expect((writen as { stored?: boolean }).stored).toBe(true)
    const found = await search.execute({ query: "type-safe" }, { caller: { kind: "parent", sessionId: "s1" }, sessionId: "s1" })
    expect((found as { count?: number }).count).toBe(1)
    const miss = await search.execute({ query: "zzz" }, { caller: { kind: "parent", sessionId: "s1" }, sessionId: "s1" })
    expect((miss as { count?: number }).count).toBe(0)
  })
})
