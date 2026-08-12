import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@newhorse/core/fs-util"
import { formatDiagnostic, lspPrepare, type Diagnostic } from "./lsp-util"
import DESCRIPTION from "./lsp-diagnostics.txt"

const MAX_DIAGNOSTICS = 100

const SEVERITY_FILTER = {
  error: 1,
  warning: 2,
  information: 3,
  hint: 4,
} as const

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  severity: Schema.optional(
    Schema.Literals(["error", "warning", "information", "hint", "all"]).annotate({
      description: "Filter diagnostics by severity level (default: all)",
    }),
  ),
})

// TODO: register this tool in tool/registry.ts once the split replaces the combined "lsp" tool.
export const LspDiagnosticsTool = Tool.define(
  "lsp_diagnostics",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = yield* lspPrepare({ ctx, operation: "diagnostics", filePath: args.filePath, fs, lsp })
          const all = yield* lsp.diagnostics()
          const key = process.platform === "win32" ? FSUtil.normalizePath(file) : file
          let diagnostics = (all[key] ?? all[file] ?? []) as Diagnostic[]
          if (args.severity && args.severity !== "all") {
            const severity = SEVERITY_FILTER[args.severity]
            diagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === severity)
          }
          const relPath = path.relative(instance.worktree, file)
          const total = diagnostics.length
          const limited = diagnostics.slice(0, MAX_DIAGNOSTICS)
          const lines = limited.map((diagnostic) => formatDiagnostic(diagnostic))
          if (total > MAX_DIAGNOSTICS) {
            lines.unshift(`Found ${total} diagnostics (showing first ${MAX_DIAGNOSTICS}):`)
          }
          return {
            title: `lsp_diagnostics ${relPath}`,
            metadata: { result: diagnostics },
            output: lines.length === 0 ? "No diagnostics found" : lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
