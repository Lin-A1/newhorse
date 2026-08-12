import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { FSUtil } from "@newhorse/core/fs-util"
import { Ripgrep } from "@newhorse/core/ripgrep"
import { Git } from "@/git"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import type * as Tool from "../../src/tool/tool"
import {
  AstGrepReplaceTool,
  AstGrepSearchTool,
  AstGrepTimeoutError,
  buildSgArgs,
  CLI_LANGUAGES,
  formatReplaceResult,
  formatSearchResult,
  parseSgResult,
  runSg,
  setAstGrepRunnerForTest,
  type CliMatch,
  type Runner,
  type SgResult,
} from "../../src/tool/ast-grep"

const toolLayer = () =>
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]))

const rooted = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const root = path.join(__dirname, "../..")

const match: CliMatch = {
  text: 'console.log("hi")',
  file: "src/a.ts",
  lines: '  console.log("hi")',
  range: { start: { line: 2, column: 3 }, end: { line: 2, column: 19 } },
  language: "TypeScript",
}

const okRunner = (matches: unknown[]): Runner => ({
  spawn: async () => ({ code: 0, stdout: JSON.stringify(matches), stderr: "" }),
  resolveBinary: async () => "/fake/sg",
})

describe("ast-grep buildSgArgs", () => {
  test("search defaults paths to ['.']", () => {
    expect(buildSgArgs({ pattern: "console.log($MSG)", lang: "javascript" })).toEqual([
      "run",
      "-p",
      "console.log($MSG)",
      "--lang",
      "javascript",
      "--json=compact",
      ".",
    ])
  })

  test("search passes paths, globs and context", () => {
    expect(
      buildSgArgs({
        pattern: "x",
        lang: "tsx",
        paths: ["src", "test"],
        globs: ["*.tsx", "!*.spec.tsx"],
        context: 2,
      }),
    ).toEqual([
      "run",
      "-p",
      "x",
      "--lang",
      "tsx",
      "--json=compact",
      "-C",
      "2",
      "--globs",
      "*.tsx",
      "--globs",
      "!*.spec.tsx",
      "src",
      "test",
    ])
  })

  test("replace dry-run omits --update-all", () => {
    expect(buildSgArgs({ pattern: "x", lang: "python", rewrite: "y", updateAll: false })).toEqual([
      "run",
      "-p",
      "x",
      "--lang",
      "python",
      "--json=compact",
      "-r",
      "y",
      ".",
    ])
  })

  test("replace apply adds --update-all", () => {
    expect(buildSgArgs({ pattern: "x", lang: "python", rewrite: "y", updateAll: true })).toEqual([
      "run",
      "-p",
      "x",
      "--lang",
      "python",
      "--json=compact",
      "-r",
      "y",
      "--update-all",
      ".",
    ])
  })

  test("language enum has 25 entries", () => {
    expect(CLI_LANGUAGES).toHaveLength(25)
    expect(CLI_LANGUAGES).toContain("typescript")
    expect(CLI_LANGUAGES).toContain("yaml")
  })
})

describe("ast-grep parseSgResult", () => {
  test("parses compact json matches", () => {
    const result = parseSgResult({ code: 0, stdout: JSON.stringify([match]), stderr: "" })
    expect(result.matches).toHaveLength(1)
    expect(result.totalMatches).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.matches[0]?.file).toBe("src/a.ts")
  })

  test("empty stdout yields no matches", () => {
    const result = parseSgResult({ code: 0, stdout: "", stderr: "" })
    expect(result.matches).toHaveLength(0)
    expect(result.error).toBeUndefined()
  })

  test("non-zero exit surfaces stderr as error", () => {
    const result = parseSgResult({ code: 2, stdout: "", stderr: "Error: failed to parse pattern" })
    expect(result.matches).toHaveLength(0)
    expect(result.error).toBe("Error: failed to parse pattern")
  })

  test("'no files found' is not an error", () => {
    const result = parseSgResult({ code: 1, stdout: "", stderr: "No files found" })
    expect(result.matches).toHaveLength(0)
    expect(result.error).toBeUndefined()
  })

  test("more than 500 matches are truncated", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ ...match, file: `src/f${i}.ts` }))
    const result = parseSgResult({ code: 0, stdout: JSON.stringify(many), stderr: "" })
    expect(result.matches).toHaveLength(500)
    expect(result.totalMatches).toBe(501)
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe("max_matches")
  })

  test("output larger than 1MB that cannot be parsed reports truncation", () => {
    const huge = { ...match, lines: "x".repeat(1024 * 1024 + 10) }
    const result = parseSgResult({ code: 0, stdout: JSON.stringify([huge]), stderr: "" })
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe("max_output_bytes")
    expect(result.error).toContain("could not be parsed")
  })

  test("truncated json is salvaged at the last complete match", () => {
    const matches = [match, { ...match, file: "src/b.ts" }, { ...match, file: "src/c.ts" }, { ...match, file: "src/d.ts" }]
    const body = "[" + matches.map((m) => JSON.stringify(m)).join(",")
    const stdout = body + " ".repeat(Math.max(0, 1024 * 1024 - body.length))
    const result = parseSgResult({ code: 0, stdout, stderr: "" })
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe("max_output_bytes")
    expect(result.matches.map((m) => m.file)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])
  })

  test("accepts json-lines output (one match object per line)", () => {
    const lines = [match, { ...match, file: "src/b.ts" }].map((m) => JSON.stringify(m)).join("\n")
    const result = parseSgResult({ code: 0, stdout: lines, stderr: "" })
    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe("ast-grep formatting", () => {
  const result: SgResult = { matches: [match], totalMatches: 1, truncated: false }

  test("search renders file:line:col plus matched line", () => {
    const output = formatSearchResult(result)
    expect(output).toContain("Found 1 match(es)")
    expect(output).toContain("src/a.ts:3:4")
    expect(output).toContain('console.log("hi")')
  })

  test("replace dry-run header", () => {
    const output = formatReplaceResult(result, true)
    expect(output).toMatch(/\[DRY RUN\] 1 replacement\(s\)/)
    expect(output).toContain("Use dryRun=false to apply changes")
  })

  test("replace apply header omits dry-run prefix", () => {
    const output = formatReplaceResult(result, false)
    expect(output).toContain("1 replacement(s)")
    expect(output).not.toContain("[DRY RUN]")
  })

  test("errors are rendered as Error:", () => {
    expect(formatSearchResult({ matches: [], totalMatches: 0, truncated: false, error: "boom" })).toBe("Error: boom")
    expect(formatReplaceResult({ matches: [], totalMatches: 0, truncated: false, error: "boom" }, true)).toBe(
      "Error: boom",
    )
  })
})

describe("ast-grep runSg", () => {
  afterEach(() => setAstGrepRunnerForTest(null))

  test("returns parsed matches", async () => {
    const result = await runSg({ pattern: "console.log($MSG)", lang: "typescript" }, okRunner([match]))
    expect(result.matches).toHaveLength(1)
    expect(result.totalMatches).toBe(1)
    expect(result.error).toBeUndefined()
  })

  test("spawns the resolved binary with built args", async () => {
    let captured: string[] = []
    const result = await runSg(
      { pattern: "console.log($MSG)", lang: "typescript", paths: ["src"] },
      {
        spawn: async ({ cmd }) => {
          captured = cmd
          return { code: 0, stdout: "[]", stderr: "" }
        },
        resolveBinary: async () => "/fake/sg",
      },
    )
    expect(result.matches).toHaveLength(0)
    expect(captured).toEqual(["/fake/sg", ...buildSgArgs({ pattern: "console.log($MSG)", lang: "typescript", paths: ["src"] })])
  })

  test("falls back to bare 'sg' then downloads and retries once on ENOENT", async () => {
    let spawnCalls = 0
    let resolveCalls = 0
    const result = await runSg(
      { pattern: "x", lang: "typescript" },
      {
        spawn: async () => {
          spawnCalls++
          if (spawnCalls === 1) {
            const error = new Error("spawn sg ENOENT") as Error & { code?: string }
            error.code = "ENOENT"
            throw error
          }
          return { code: 0, stdout: JSON.stringify([match]), stderr: "" }
        },
        resolveBinary: async () => {
          resolveCalls++
          return resolveCalls === 1 ? null : "/downloaded/sg"
        },
      },
    )
    expect(result.matches).toHaveLength(1)
    expect(spawnCalls).toBe(2)
    expect(resolveCalls).toBe(2)
  })

  test("ENOENT without a downloadable binary reports not-found instructions", async () => {
    const result = await runSg(
      { pattern: "x", lang: "typescript" },
      {
        spawn: async () => {
          const error = new Error("spawn sg ENOENT") as Error & { code?: string }
          error.code = "ENOENT"
          throw error
        },
        resolveBinary: async () => null,
      },
    )
    expect(result.error).toContain("not found")
    expect(result.error).toContain("AST_GREP_BIN")
  })

  test("timeout is reported as truncated", async () => {
    const result = await runSg(
      { pattern: "x", lang: "typescript" },
      {
        spawn: async () => {
          throw new AstGrepTimeoutError(300_000)
        },
        resolveBinary: async () => "/fake/sg",
      },
    )
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe("timeout")
    expect(result.error).toContain("timed out")
  })

  test("generic spawn failure is surfaced", async () => {
    const result = await runSg(
      { pattern: "x", lang: "typescript" },
      {
        spawn: async () => {
          throw new Error("boom")
        },
        resolveBinary: async () => "/fake/sg",
      },
    )
    expect(result.error).toContain("Failed to spawn ast-grep")
    expect(result.error).toContain("boom")
  })

  test("stderr error from a non-zero exit is surfaced", async () => {
    const result = await runSg(
      { pattern: "x", lang: "typescript" },
      {
        spawn: async () => ({ code: 2, stdout: "", stderr: "Error: failed to parse pattern" }),
        resolveBinary: async () => "/fake/sg",
      },
    )
    expect(result.error).toBe("Error: failed to parse pattern")
  })
})

describe("ast-grep tools", () => {
  afterEach(() => setAstGrepRunnerForTest(null))

  rooted.live("search formats matches from sg output", () =>
    Effect.gen(function* () {
      setAstGrepRunnerForTest(okRunner([match]))
      const info = yield* AstGrepSearchTool
      const tool = yield* info.init()
      const result = yield* provideInstance(root)(
        tool.execute({ pattern: "console.log($MSG)", lang: "typescript", paths: ["src"] }, ctx),
      )
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain("Found 1 match(es)")
      expect(result.output).toContain("src/a.ts:3:4")
    }),
  )

  rooted.live("replace dry-runs by default", () =>
    Effect.gen(function* () {
      setAstGrepRunnerForTest(okRunner([match]))
      const info = yield* AstGrepReplaceTool
      const tool = yield* info.init()
      const result = yield* provideInstance(root)(
        tool.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", lang: "typescript" }, ctx),
      )
      expect(result.output).toMatch(/\[DRY RUN\] 1 replacement\(s\)/)
      expect(result.output).toContain("Use dryRun=false to apply changes")
    }),
  )

  rooted.live("replace asks permission and applies changes when dryRun=false", () =>
    Effect.gen(function* () {
      const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      let captured: string[] = []
      setAstGrepRunnerForTest({
        spawn: async ({ cmd }) => {
          captured = cmd
          return { code: 0, stdout: JSON.stringify([match]), stderr: "" }
        },
        resolveBinary: async () => "/fake/sg",
      })
      const next: Tool.Context = {
        ...ctx,
        ask: (req) =>
          Effect.sync(() => {
            asks.push(req)
          }),
      }
      const info = yield* AstGrepReplaceTool
      const tool = yield* info.init()
      const result = yield* provideInstance(root)(
        tool.execute(
          { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", lang: "typescript", dryRun: false },
          next,
        ),
      )
      expect(asks[0]?.permission).toBe("ast_grep_replace")
      expect(asks[0]?.metadata?.rewrite).toBe("logger.info($MSG)")
      expect(captured).toContain("--update-all")
      expect(captured).toContain("-r")
      expect(result.output).toContain("1 replacement(s)")
    }),
  )
})
