import { describe, expect } from "bun:test"
import { afterEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { lspToolTestLayer } from "./lsp-helpers"
import { LspPrepareRenameTool } from "../../src/tool/lsp-prepare-rename"

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
let prepareRenameResult: unknown[] = []

const it = testEffect(
  lspToolTestLayer({
    prepareRename: (position) => {
      positions.push({ line: position.line, character: position.character })
      return Effect.succeed(prepareRenameResult)
    },
  }),
)

describe("tool.lsp_prepare_rename", () => {
  it.instance(
    "formats a rename result with placeholder",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        prepareRenameResult = [
          {
            range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } },
            placeholder: "x",
          },
        ]

        const info = yield* LspPrepareRenameTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 7 }, ctx)

        expect(result.title).toBe("lsp_prepare_rename test.ts:1:7")
        expect(result.output).toBe('Rename available at 1:7-1:8 (current: "x")')
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
        prepareRenameResult = []

        const info = yield* LspPrepareRenameTool
        const tool = yield* info.init()
        yield* tool.execute({ filePath: file, line: 4, character: 2 }, ctx)

        expect(positions).toEqual([{ line: 3, character: 2 }])
      }),
    { git: true },
  )

  it.instance(
    "reports cannot rename when the server returns nothing",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        prepareRenameResult = []

        const info = yield* LspPrepareRenameTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 0 }, ctx)

        expect(result.output).toBe("Cannot rename at this position")
      }),
    { git: true },
  )
})
