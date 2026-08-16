import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./workbench.txt"
import { Workbench } from "@/workbench"
import { InstanceState } from "@/effect/instance-state"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "list", "update", "remove"]),
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["open", "in_progress", "done", "cancelled"])),
  priority: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  deadline: Schema.optional(Schema.Number),
})

type Metadata = { count?: number }

function render(items: Workbench.Todo[]) {
  if (items.length === 0) return "No workbench todos."
  return items
    .map(
      (item) =>
        `- [${item.id}] (${item.status}; ${item.priority}) ${item.content}${
          item.deadline ? ` due ${new Date(item.deadline).toISOString()}` : ""
        }`,
    )
    .join("\n")
}

export const WorkbenchTool = Tool.define<typeof Parameters, Metadata, Workbench.Service>(
  "workbench",
  Effect.gen(function* () {
    const workbench = yield* Workbench.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          if (params.action === "list") {
            const items = yield* workbench.list({ directory: instance.directory })
            return { title: `${items.length} todos`, metadata: { count: items.length }, output: render(items) }
          }

          if (params.action === "create") {
            if (!params.content?.trim()) return yield* Effect.fail(new Error("create requires content"))
            const created = yield* workbench.create({
              directory: instance.directory,
              content: params.content,
              priority: params.priority,
              deadline: params.deadline,
              source: "newhorse",
            })
            return {
              title: "Todo created",
              metadata: { count: 1 },
              output: render([created]),
            }
          }

          if (params.action === "update") {
            if (!params.id) return yield* Effect.fail(new Error("update requires id"))
            const updated = yield* workbench.update({
              id: params.id,
              directory: instance.directory,
              content: params.content,
              status: params.status,
              priority: params.priority,
              deadline: params.deadline,
            })
            if (!updated) return yield* Effect.fail(new Error(`Todo not found: ${params.id}`))
            return { title: "Todo updated", metadata: {}, output: render([updated]) }
          }

          if (params.action === "remove") {
            if (!params.id) return yield* Effect.fail(new Error("remove requires id"))
            const removed = yield* workbench.remove({ id: params.id, directory: instance.directory })
            if (!removed) return yield* Effect.fail(new Error(`Todo not found: ${params.id}`))
            return { title: "Todo removed", metadata: {}, output: "Todo removed." }
          }

          return yield* Effect.fail(new Error(`Unknown action: ${params.action}`))
        }),
    }
  }),
)
