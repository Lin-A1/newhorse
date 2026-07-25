import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory, SensitiveMemoryRejected } from "@/memory"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "save", "accept", "reject", "forget"]).annotate({
    description: "The memory operation to perform",
  }),
  content: Schema.optional(Schema.String).annotate({ description: "Content to remember (required for save)" }),
  kind: Schema.optional(Schema.Literals(["preference", "fact", "goal", "event", "relationship", "summary"])).annotate({
    description: "Category of the memory (required for save)",
  }),
  provenance: Schema.optional(Schema.Literals(["user_explicit", "user_confirmed", "model_inferred"])).annotate({
    description: "Where this memory came from (required for save)",
  }),
  scope: Schema.optional(Schema.Literals(["workspace", "user_global"])).annotate({
    description: "Defaults to workspace. Use user_global only for durable cross-workspace preferences.",
  }),
  id: Schema.optional(Schema.String).annotate({ description: "Memory id (required for accept/reject/forget)" }),
})

function render(items: Memory.Info[]) {
  if (items.length === 0) return "No memory stored."
  return items
    .map((item) => {
      const flags = [item.status, item.scope, item.provenance].join(", ")
      return `- [${item.id}] (${item.kind}; ${flags}) ${item.content}`
    })
    .join("\n")
}

type Metadata = {
  id?: string
  status?: string
}

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const items = yield* memory.list()
            return { title: `${items.length} memories`, metadata: {}, output: render(items) }
          }

          if (params.action === "save") {
            if (!params.content || !params.kind || !params.provenance) {
              return yield* Effect.fail(new Error("save requires content, kind, and provenance"))
            }
            yield* ctx.ask({
              permission: "memory",
              patterns: ["*"],
              always: ["*"],
              metadata: { content: params.content, kind: params.kind, scope: params.scope ?? "workspace" },
            })
            const saved = yield* memory
              .save({
                content: params.content,
                kind: params.kind,
                provenance: params.provenance,
                scope: params.scope,
                sourceSessionID: ctx.sessionID,
              })
              .pipe(
                Effect.catchTag("SensitiveMemoryRejected", (error: SensitiveMemoryRejected) =>
                  Effect.fail(new Error(error.message)),
                ),
              )
            return {
              title: saved.status === "proposed" ? "Memory proposed" : "Memory saved",
              metadata: { id: saved.id, status: saved.status },
              output: `${saved.status === "proposed" ? "Proposed" : "Saved"} [${saved.id}]: ${saved.content}`,
            }
          }

          if (!params.id) return yield* Effect.fail(new Error(`${params.action} requires an id`))

          if (params.action === "forget") {
            yield* ctx.ask({
              permission: "memory",
              patterns: ["*"],
              always: ["*"],
              metadata: { id: params.id, action: "forget" },
            })
            yield* memory.forget(params.id)
            return { title: "Memory forgotten", metadata: { id: params.id }, output: `Deleted [${params.id}]` }
          }

          const status = params.action === "accept" ? "active" : "rejected"
          yield* memory.setStatus({ id: params.id, status })
          return {
            title: `Memory ${status}`,
            metadata: { id: params.id, status },
            output: `Marked [${params.id}] as ${status}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
