import path from "path"
import { pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@newhorse/core/fs-util"
import { formatDocumentSymbol, formatSymbolInfo, lspPrepare, type DocumentSymbol, type SymbolInfo } from "./lsp-util"
import DESCRIPTION from "./lsp-symbols.txt"

const DEFAULT_MAX_SYMBOLS = 50

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "The absolute or relative path to the file (used to select the LSP server)",
  }),
  scope: Schema.optional(
    Schema.Literals(["document", "workspace"]).annotate({
      description: "'document' for the file outline, 'workspace' for a project-wide symbol search",
    }),
  ),
  query: Schema.optional(Schema.String).annotate({
    description: "Symbol name to search. Required for workspace scope. Empty string requests all symbols.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: `Maximum number of results (default ${DEFAULT_MAX_SYMBOLS})`,
  }),
})

// TODO: register this tool in tool/registry.ts once the split replaces the combined "lsp" tool.
export const LspSymbolsTool = Tool.define(
  "lsp_symbols",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const scope = args.scope ?? "document"
          const limit = Math.min(args.limit ?? DEFAULT_MAX_SYMBOLS, DEFAULT_MAX_SYMBOLS)

          if (scope === "workspace") {
            // The file is used to select the LSP server but is not sent with the
            // workspace/symbol request, so it is omitted from permission metadata.
            const file = yield* lspPrepare({
              ctx,
              operation: "workspaceSymbol",
              filePath: args.filePath,
              query: args.query ?? "",
              omitFile: true,
              fs,
              lsp,
            })
            const result: unknown[] = yield* lsp.workspaceSymbol(args.query ?? "")
            const symbols = result as SymbolInfo[]
            const total = symbols.length
            const limited = symbols.slice(0, limit)
            const lines = limited.map((symbol) => formatSymbolInfo(symbol))
            if (total > limit) lines.unshift(`Found ${total} symbols (showing first ${limit}):`)
            return {
              title: "lsp_symbols workspace",
              metadata: { result },
              output: lines.length === 0 ? "No symbols found" : lines.join("\n"),
            }
          }

          const file = yield* lspPrepare({ ctx, operation: "documentSymbol", filePath: args.filePath, fs, lsp })
          const relPath = path.relative(instance.worktree, file)
          const result: unknown[] = yield* lsp.documentSymbol(pathToFileURL(file).href)
          const symbols = result as (DocumentSymbol | SymbolInfo)[]
          const total = symbols.length
          const limited = symbols.slice(0, limit)
          const lines: string[] = []
          if (total > limit) lines.push(`Found ${total} symbols (showing first ${limit}):`)
          if (limited.length === 0) {
            return {
              title: `lsp_symbols document ${relPath}`,
              metadata: { result },
              output: "No symbols found",
            }
          }
          if ("range" in limited[0]) {
            lines.push(...(limited as DocumentSymbol[]).map((symbol) => formatDocumentSymbol(symbol)))
          } else {
            lines.push(...(limited as SymbolInfo[]).map((symbol) => formatSymbolInfo(symbol)))
          }
          return {
            title: `lsp_symbols document ${relPath}`,
            metadata: { result },
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
