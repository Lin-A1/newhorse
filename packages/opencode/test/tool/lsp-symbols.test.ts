import { describe, expect } from "bun:test"
import { afterEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { lspToolTestLayer } from "./lsp-helpers"
import { LspSymbolsTool } from "../../src/tool/lsp-symbols"
import { LSP } from "@/lsp/lsp"

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

const documentSymbolUris: string[] = []
const workspaceQueries: string[] = []
let documentSymbolResult: unknown[] = []
let workspaceSymbolResult: unknown[] = []

const it = testEffect(
  lspToolTestLayer({
    documentSymbol: (uri) => {
      documentSymbolUris.push(uri)
      return Effect.succeed(documentSymbolResult as LSP.DocumentSymbol[])
    },
    workspaceSymbol: (query) => {
      workspaceQueries.push(query)
      return Effect.succeed(workspaceSymbolResult as LSP.Symbol[])
    },
  }),
)

describe("tool.lsp_symbols", () => {
  it.instance(
    "formats document symbols by default",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        documentSymbolResult = [
          {
            name: "foo",
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            children: [
              {
                name: "inner",
                kind: 6,
                range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
                selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
              },
            ],
          },
        ]

        const info = yield* LspSymbolsTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file }, ctx)

        expect(result.title).toBe("lsp_symbols document test.ts")
        expect(result.output).toBe("foo (Function) - line 1\n  inner (Method) - line 2")
      }),
    { git: true },
  )

  it.instance(
    "passes document uri to documentSymbol",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        documentSymbolUris.length = 0
        documentSymbolResult = []

        const info = yield* LspSymbolsTool
        const tool = yield* info.init()
        yield* tool.execute({ filePath: file, scope: "document" }, ctx)

        expect(documentSymbolUris.length).toBe(1)
        expect(documentSymbolUris[0]).toContain("file://")
        expect(decodeURIComponent(documentSymbolUris[0]!)).toContain("test.ts")
      }),
    { git: true },
  )

  it.instance(
    "formats workspace symbols and passes the query",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        workspaceQueries.length = 0
        workspaceSymbolResult = [
          {
            name: "Foo",
            kind: 5,
            location: {
              uri: `file://${path.join(dir, "a.ts")}`,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
            containerName: "ns",
          },
        ]

        const info = yield* LspSymbolsTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, scope: "workspace", query: "Foo" }, ctx)

        expect(workspaceQueries).toEqual(["Foo"])
        expect(result.title).toBe("lsp_symbols workspace")
        expect(result.output).toBe(`Foo (Class) (in ns) - ${path.join(dir, "a.ts")}:1:0`)
      }),
    { git: true },
  )

  it.instance(
    "uses empty query when workspace query is omitted",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        workspaceQueries.length = 0
        workspaceSymbolResult = []

        const info = yield* LspSymbolsTool
        const tool = yield* info.init()
        yield* tool.execute({ filePath: file, scope: "workspace" }, ctx)

        expect(workspaceQueries).toEqual([""])
      }),
    { git: true },
  )
})
