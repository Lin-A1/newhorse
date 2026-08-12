import { describe, expect } from "bun:test"
import { afterEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { lspToolTestLayer } from "./lsp-helpers"
import { LspDiagnosticsTool } from "../../src/tool/lsp-diagnostics"
import { FSUtil } from "@newhorse/core/fs-util"
import type { Diagnostic as LSPDiagnostic } from "@/lsp/client"

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

let diagnosticsResult: Record<string, LSPDiagnostic[]> = {}

const it = testEffect(
  lspToolTestLayer({
    diagnostics: () => Effect.succeed(diagnosticsResult),
  }),
)

describe("tool.lsp_diagnostics", () => {
  it.instance(
    "formats diagnostics for the target file",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        const key = process.platform === "win32" ? FSUtil.normalizePath(file) : file
        diagnosticsResult = {
          [key]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              source: "ts",
              code: 2322,
              message: "Type 'number' is not assignable to type 'string'",
            },
          ],
        }

        const info = yield* LspDiagnosticsTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file }, ctx)

        expect(result.title).toBe("lsp_diagnostics test.ts")
        expect(result.output).toBe("error[ts] (2322) at 1:0: Type 'number' is not assignable to type 'string'")
      }),
    { git: true },
  )

  it.instance(
    "filters diagnostics by severity",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        const key = process.platform === "win32" ? FSUtil.normalizePath(file) : file
        diagnosticsResult = {
          [key]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              message: "error one",
            },
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
              severity: 2,
              message: "warning one",
            },
          ],
        }

        const info = yield* LspDiagnosticsTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file, severity: "warning" }, ctx)

        expect(result.output).toBe("warning at 2:0: warning one")
        expect(result.metadata.result).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "reports no diagnostics found",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
        diagnosticsResult = {}

        const info = yield* LspDiagnosticsTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ filePath: file }, ctx)

        expect(result.output).toBe("No diagnostics found")
      }),
    { git: true },
  )
})
