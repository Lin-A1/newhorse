import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@newhorse/core/fs-util"
import { applyWorkspaceEdit, formatApplyResult, lspPrepare, type WorkspaceEdit } from "./lsp-util"
import DESCRIPTION from "./lsp-rename.txt"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "The character offset (0-based, as used by the language server)",
  }),
  newName: Schema.String.annotate({ description: "The new name for the symbol" }),
})

// TODO: register this tool in tool/registry.ts once the split replaces the combined "lsp" tool.
export const LspRenameTool = Tool.define(
  "lsp_rename",
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
            operation: "rename",
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            newName: args.newName,
            fs,
            lsp,
          })
          const results: unknown[] = yield* lsp.rename({
            file,
            line: args.line - 1,
            character: args.character,
            newName: args.newName,
          })
          const edit = results.find((result) => result != null) as WorkspaceEdit | undefined
          const applied = yield* applyWorkspaceEdit({ ctx, edit, fs })
          const relPath = path.relative(instance.worktree, file)
          return {
            title: `lsp_rename ${relPath}:${args.line}:${args.character} -> ${args.newName}`,
            metadata: { result: edit ?? null, newName: args.newName },
            output: formatApplyResult(applied),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
