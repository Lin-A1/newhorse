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
            // Cross-directory: work sessions list their own workspace's todos,
            // but the Companion (newhorse) session lives in the personal
            // workspace and must still see todos created in any project
            // workspace — so list always queries across directories.
            const items = yield* workbench.listOpen(50)
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

          if (params.action === "update" || params.action === "remove") {
            if (!params.id) return yield* Effect.fail(new Error(`${params.action} requires id`))
            // Todos are cross-directory (Companion lists them across all
            // workspaces), so resolve the owning directory by id before the
            // scoped update/remove call.
            const all = yield* workbench.listOpen(200)
            const target = all.find((item) => item.id === params.id)
            if (!target) return yield* Effect.fail(new Error(`Todo not found: ${params.id}`))
            if (params.action === "remove") {
              const removed = yield* workbench.remove({ id: params.id, directory: target.directory })
              if (!removed) return yield* Effect.fail(new Error(`Todo not found: ${params.id}`))
              return { title: "Todo removed", metadata: {}, output: "Todo removed." }
            }
            const updated = yield* workbench.update({
              id: params.id,
              directory: target.directory,
              content: params.content,
              status: params.status,
              priority: params.priority,
              deadline: params.deadline,
            })
            if (!updated) return yield* Effect.fail(new Error(`Todo not found: ${params.id}`))
            return { title: "Todo updated", metadata: {}, output: render([updated]) }
          }

          return yield* Effect.fail(new Error(`Unknown action: ${params.action}`))
        }),
    }
  }),
)
