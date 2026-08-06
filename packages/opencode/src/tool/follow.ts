import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./follow.txt"
import { Follow, type FollowInfo } from "@/follow"
import { Session } from "@/session/session"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "list", "remove"]),
  id: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["topic", "deadline", "release", "price"])),
  topic: Schema.optional(Schema.String),
  checkIntervalMinutes: Schema.optional(Schema.Int),
})

type Metadata = { id?: string; status?: string }

function render(items: FollowInfo[]) {
  if (items.length === 0) return "You are not following anything."
  return items
    .map((item) => `- [${item.id}] (${item.kind}) ${item.topic}`)
    .join("\n")
}

export const FollowTool = Tool.define<
  typeof Parameters,
  Metadata,
  Follow.Service | Session.Service
>(
  "follow",
  Effect.gen(function* () {
    const follow = yield* Follow.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID)

          if (params.action === "create") {
            if (!params.kind || !params.topic?.trim()) {
              return { title: "create", metadata: {}, output: "create requires kind (topic|deadline|release|price) and topic" }
            }
            const created = yield* follow.create({
              kind: params.kind,
              topic: params.topic,
              checkIntervalMinutes: params.checkIntervalMinutes,
              profileID: session.profileID,
              directory: session.directory,
            })
            return {
              title: `Now following: ${created.topic}`,
              metadata: { id: created.id, status: created.status },
              output: `Now following: ${created.topic} (${created.kind}). I'll check it and let you know when something changes.`,
            }
          }

          if (params.action === "remove") {
            if (!params.id) return { title: "remove", metadata: {}, output: "remove requires the follow id" }
            yield* follow.remove(params.id)
            return {
              title: `Stopped following ${params.id}`,
              metadata: { id: params.id },
              output: `Stopped following ${params.id}.`,
            }
          }

          const items = yield* follow.list()
          return { title: "Follows", metadata: {}, output: render(items) }
        }),
    }
  }),
)
