import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@newhorse/core/fs-util"
import {
  formatPrepareRenameResult,
  lspPrepare,
  type PrepareRenameDefaultBehavior,
  type PrepareRenameResult,
  type Range,
} from "./lsp-util"
import DESCRIPTION from "./lsp-prepare-rename.txt"

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
export const LspPrepareRenameTool = Tool.define(
  "lsp_prepare_rename",
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
            operation: "prepareRename",
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            fs,
            lsp,
          })
          const result: unknown[] = yield* lsp.prepareRename({ file, line: args.line - 1, character: args.character })
          const info = result[0] as PrepareRenameResult | PrepareRenameDefaultBehavior | Range | undefined
          const relPath = path.relative(instance.worktree, file)
          return {
            title: `lsp_prepare_rename ${relPath}:${args.line}:${args.character}`,
            metadata: { result },
            output: formatPrepareRenameResult(info),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
