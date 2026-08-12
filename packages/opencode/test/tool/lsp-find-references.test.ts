import { describe, expect } from "bun:test"
import { afterEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { lspToolTestLayer } from "./lsp-helpers"
import { LspFindReferencesTool } from "../../src/tool/lsp-find-references"

afterEach(async () => {
  await disposeAllInstances()
})

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

const positions: Array<{ line: number; character: number }> = []
let referencesResult: unknown[] = []

const it = testEffect(
  lspToolTestLayer({
    references: (position) => {
      positions.push({ line: position.line, character: position.character })
      return Effect.succeed(referencesResult)
    },
  }),
)

describe("tool.lsp_find_references", () => {
  it.instance(
    "formats reference locations",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        referencesResult = [
          {
            uri: pathToFileURL(file).href,
            range: { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } },
          },
          {
            uri: pathToFileURL(path.join(dir, "other.ts")).href,
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } },
          },
        ]

        const info = yield* LspFindReferencesTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 0 }, ctx)

        expect(result.output).toBe(`${file}:2:10\n${path.join(dir, "other.ts")}:5:2`)
        expect(result.title).toBe("lsp_find_references test.ts:1:0")
      }),
    { git: true },
  )

  it.instance(
    "converts 1-based line to a 0-based LSP position",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        positions.length = 0
        referencesResult = []

        const info = yield* LspFindReferencesTool
        const tool = yield* info.init()
        yield* tool.execute({ filePath: file, line: 5, character: 3 }, ctx)

        expect(positions).toEqual([{ line: 4, character: 3 }])
      }),
    { git: true },
  )

  it.instance(
    "reports no references found",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        referencesResult = []

        const info = yield* LspFindReferencesTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 0 }, ctx)

        expect(result.output).toBe("No references found")
      }),
    { git: true },
  )
})
