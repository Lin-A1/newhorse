import { describe, expect } from "bun:test"
import { afterEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { lspToolTestLayer } from "./lsp-helpers"
import { LspGotoDefinitionTool } from "../../src/tool/lsp-goto-definition"

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
let definitionResult: unknown[] = []

const it = testEffect(
  lspToolTestLayer({
    definition: (position) => {
      positions.push({ line: position.line, character: position.character })
      return Effect.succeed(definitionResult)
    },
  }),
)

describe("tool.lsp_goto_definition", () => {
  it.instance(
    "converts 1-based line and 0-based character to LSP positions",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        positions.length = 0
        definitionResult = []

        const info = yield* LspGotoDefinitionTool
        const tool = yield* info.init()
        yield* tool.execute({ filePath: file, line: 3, character: 7 }, ctx)

        expect(positions).toEqual([{ line: 2, character: 7 }])
      }),
    { git: true },
  )

  it.instance(
    "formats definition locations",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        definitionResult = [
          {
            uri: pathToFileURL(file).href,
            range: { start: { line: 1, character: 3 }, end: { line: 1, character: 4 } },
          },
        ]

        const info = yield* LspGotoDefinitionTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 0 }, ctx)

        expect(result.title).toBe("lsp_goto_definition test.ts:1:0")
        expect(result.output).toBe(`${file}:2:3`)
        expect(result.metadata.result).toEqual(definitionResult)
      }),
    { git: true },
  )

  it.instance(
    "reports no definition found",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        definitionResult = []

        const info = yield* LspGotoDefinitionTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 0 }, ctx)

        expect(result.output).toBe("No definition found")
      }),
    { git: true },
  )
})
