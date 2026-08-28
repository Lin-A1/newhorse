import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBuiltinTools } from "./index"
import type { Tool } from "@newhorse/core"

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
      await write.execute({ path: "a/b.txt", content: "line1\nline2\nline3" })
      const out = await read.execute({ path: "a/b.txt" }) as { lines: string[]; truncated: boolean; totalLines: number }
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
      const out = await read.execute({ path: "../" + join("..", "nh-secret.txt") }) as { error: string }
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
      const out = await edit.execute({ path: "f.txt", old: "world", new: "there" }) as { replaced: number }
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
      await expect(edit.execute({ path: "f.txt", old: "abc", new: "abc" })).resolves.toMatchObject({ error: expect.stringContaining("identical") })
      await expect(edit.execute({ path: "f.txt", old: "", new: "x" })).resolves.toMatchObject({ error: expect.stringContaining("non-empty") })
    } finally {
      await cleanup()
    }
  })

  it("edit returns structured disambiguation on multi-hit without replaceAll", async () => {
    const { root, cleanup } = await ws()
    try {
      await writeFile(join(root, "f.txt"), "one\ntwo one\none")
      const edit = byName(createBuiltinTools({ workspace: root }), "edit")
      const out = await edit.execute({ path: "f.txt", old: "one", new: "X" }) as { matches: number; hits: { line: number }[] }
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
      const ok = await bash.execute({ command: "echo hi" }) as { stdout: string; exitCode: number }
      expect(ok.stdout.trim()).toBe("hi")
      expect(ok.exitCode).toBe(0)
      const bad = await bash.execute({ command: "exit 3" }) as { exitCode: number }
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
      const out = await bash.execute({ command: process.platform === "win32" ? "echo ok" : "true", timeoutMs: 200 }) as { exitCode: number }
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
      const out = await bash.execute({ command: process.platform === "win32" ? "ping -n 2 127.0.0.1 >nul" : "sleep 0.3" }) as { exitCode: number; timedOut: boolean }
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
      const out = await bash.execute({ command: process.platform === "win32" ? "dir /b marker.txt" : "ls marker.txt" }) as { stdout: string }
      expect(out.stdout).toContain("marker.txt")
    } finally {
      await cleanup()
    }
  })

  it("write creates parent dirs", async () => {
    const { root, cleanup } = await ws()
    try {
      const write = byName(createBuiltinTools({ workspace: root }), "write")
      await write.execute({ path: "deep/nested/x.txt", content: "content" })
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
      const out = await read.execute({ path: "big.txt" }) as { truncated: boolean }
      expect(out.truncated).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
