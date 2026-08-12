import { describe, expect } from "bun:test"
import { afterEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { lspToolTestLayer } from "./lsp-helpers"
import { LspRenameTool } from "../../src/tool/lsp-rename"

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

const renameRequests: Array<{ line: number; character: number; newName: string }> = []
let renameResult: unknown[] = []

const it = testEffect(
  lspToolTestLayer({
    rename: (input) => {
      renameRequests.push({ line: input.line, character: input.character, newName: input.newName })
      return Effect.succeed(renameResult)
    },
  }),
)

describe("tool.lsp_rename", () => {
  it.instance(
    "applies the workspace edit to the file",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const oldName = 1\n"))
        renameResult = [
          {
            changes: {
              [pathToFileURL(file).href]: [
                {
                  range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
                  newText: "newName",
                },
              ],
            },
          },
        ]

        const info = yield* LspRenameTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 13, newName: "newName" }, ctx)

        const content = yield* Effect.promise(() => Bun.file(file).text())
        expect(content).toBe("export const newName = 1\n")
        expect(result.title).toBe("lsp_rename test.ts:1:13 -> newName")
        expect(result.output).toContain("Applied 1 edit(s) to 1 file(s):")
        expect(result.output).toContain(file)
        expect(result.metadata.newName).toBe("newName")
      }),
    { git: true },
  )

  it.instance(
    "converts 1-based line to a 0-based LSP position and passes newName",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const oldName = 1\n"))
        renameRequests.length = 0
        renameResult = []

        const info = yield* LspRenameTool
        const tool = yield* info.init()
        yield* tool.execute({ filePath: file, line: 5, character: 2, newName: "renamed" }, ctx)

        expect(renameRequests).toEqual([{ line: 4, character: 2, newName: "renamed" }])
      }),
    { git: true },
  )

  it.instance(
    "reports a failure when the server returns no edit",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const oldName = 1\n"))
        renameResult = []

        const info = yield* LspRenameTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, line: 1, character: 13, newName: "newName" }, ctx)

        expect(result.output).toBe("Failed to apply some changes:\n  Error: No workspace edit returned by the language server")
        expect(result.metadata.result).toBeNull()
      }),
    { git: true },
  )
})
