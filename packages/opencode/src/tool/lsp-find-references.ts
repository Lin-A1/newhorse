import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@newhorse/core/fs-util"
import { formatLocation, lspPrepare, type Location } from "./lsp-util"
import DESCRIPTION from "./lsp-find-references.txt"

const MAX_REFERENCES = 100

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
export const LspFindReferencesTool = Tool.define(
  "lsp_find_references",
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
            operation: "findReferences",
            filePath: args.filePath,
            line: args.line,
            character: args.character,
            fs,
            lsp,
          })
          const result: unknown[] = yield* lsp.references({ file, line: args.line - 1, character: args.character })
          const locations = result as Location[]
          const relPath = path.relative(instance.worktree, file)
          const total = locations.length
          const limited = locations.slice(0, MAX_REFERENCES)
          const lines = limited.map((loc) => formatLocation(loc))
          if (total > MAX_REFERENCES) {
            lines.unshift(`Found ${total} references (showing first ${MAX_REFERENCES}):`)
          }
          return {
            title: `lsp_find_references ${relPath}:${args.line}:${args.character}`,
            metadata: { result },
            output: lines.length === 0 ? "No references found" : lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
