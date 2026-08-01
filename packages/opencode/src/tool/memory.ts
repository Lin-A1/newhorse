import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory, MemoryPolicyRejected, SensitiveMemoryRejected } from "@/memory"
import { Session } from "@/session/session"
import { Profile } from "@/profile"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "save", "forget"]).annotate({
    description: "The memory operation to perform",
  }),
  content: Schema.optional(Schema.String).annotate({ description: "Content to remember (required for save)" }),
  kind: Schema.optional(Memory.Kind).annotate({
    description: "Category of the memory (required for save)",
  }),
  scope: Schema.optional(Memory.Scope).annotate({
    description: "Defaults to workspace. Use user_global only for durable cross-workspace preferences.",
  }),
  id: Schema.optional(Schema.String).annotate({ description: "Memory id (required for forget)" }),
})

function render(items: ReadonlyArray<Memory.Info>) {
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

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Memory.Service | Session.Service | Profile.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const sessions = yield* Session.Service
    const profiles = yield* Profile.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID)
          const profile = yield* profiles.runtime(session.profileID ?? Profile.ID.make("assistant"))

          if (params.action === "list") {
            const page = yield* memory.page({ profileID: profile.id, limit: 50 })
            return {
              title: page.nextCursor ? `${page.items.length}+ memories` : `${page.items.length} memories`,
              metadata: {},
              output: page.nextCursor
                ? `${render(page.items)}\n\nShowing the 50 most recent memories.`
                : render(page.items),
            }
          }

          if (params.action === "save") {
            if (!params.content || !params.kind) {
              return yield* Effect.fail(new Error("save requires content and kind"))
            }
            if (profile.memory === "off") return yield* Effect.fail(new Error("Memory is disabled for this profile"))
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
                provenance: "model_inferred",
                scope: params.scope,
                sourceSessionID: ctx.sessionID,
                sourceMessageID: ctx.messageID,
                profileID: profile.id,
              })
              .pipe(
                Effect.catchTags({
                  SensitiveMemoryRejected: (error: SensitiveMemoryRejected) => Effect.fail(new Error(error.message)),
                  MemoryPolicyRejected: (error: MemoryPolicyRejected) => Effect.fail(new Error(error.message)),
                }),
              )
            return {
              title: "Memory proposed",
              metadata: { id: saved.id, status: saved.status },
              output: `Proposed [${saved.id}]: ${saved.content}`,
            }
          }

          if (!params.id) return yield* Effect.fail(new Error(`${params.action} requires an id`))

          yield* ctx.ask({
            permission: "memory",
            patterns: ["*"],
            always: ["*"],
            metadata: { id: params.id, action: "forget", scope: params.scope ?? "workspace" },
          })
          const removed = yield* memory.forget(params.id, params.scope, profile.id)
          if (!removed) return yield* Effect.fail(new Error(`Memory not found: ${params.id}`))
          return { title: "Memory forgotten", metadata: { id: params.id }, output: `Deleted [${params.id}]` }
        }),
    }
  }),
)
