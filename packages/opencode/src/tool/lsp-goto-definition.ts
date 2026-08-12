import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@newhorse/core/fs-util"
import { formatLocation, lspPrepare, type Location, type LocationLink } from "./lsp-util"
import DESCRIPTION from "./lsp-goto-definition.txt"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "The character offset (0-based, as used by the language server)",
  }),
})

// TODO: register this tool in tool/registry.ts once the split replaces the combined "lsp" tool.
export const LspGotoDefinitionTool = Tool.define(
  "lsp_goto_definition",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = yield* lspPrepare({
            ctx,
            operation: "goToDefinition",
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            fs,
            lsp,
          })
          const result: unknown[] = yield* lsp.definition({ file, line: args.line - 1, character: args.character })
          const locations = result as (Location | LocationLink)[]
          const relPath = path.relative(instance.worktree, file)
          return {
            title: `lsp_goto_definition ${relPath}:${args.line}:${args.character}`,
            metadata: { result },
            output:
              locations.length === 0 ? "No definition found" : locations.map((loc) => formatLocation(loc)).join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
