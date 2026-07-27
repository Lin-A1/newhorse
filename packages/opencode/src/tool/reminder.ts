import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./reminder.txt"
import { Scheduler } from "@/scheduler"
import { Session } from "@/session/session"
import { Profile } from "@/profile"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "list", "update", "cancel"]),
  id: Schema.optional(Scheduler.ID),
  type: Schema.optional(Scheduler.Type),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  scheduleAt: Schema.optional(Schema.Int),
  timezone: Schema.optional(Schema.String),
  paused: Schema.optional(Schema.Boolean),
})

type Metadata = { id?: string; status?: string }

function render(items: Scheduler.Info[]) {
  if (items.length === 0) return "No reminders stored."
  return items
    .map(
      (item) =>
        `- [${item.id}] (${item.status}; ${item.type}) ${item.title} — ${item.body} at ${item.scheduleAt} ${item.timezone}`,
    )
    .join("\n")
}

export const ReminderTool = Tool.define<
  typeof Parameters,
  Metadata,
  Scheduler.Service | Session.Service | Profile.Service
>(
  "reminder",
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service
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
            const items = yield* scheduler.list({ profileID: profile.id })
            return { title: `${items.length} reminders`, metadata: {}, output: render(items) }
          }

          if (params.action === "create") {
            if (!params.title?.trim() || !params.body?.trim() || params.scheduleAt === undefined || !params.timezone) {
              return yield* Effect.fail(new Error("create requires title, body, scheduleAt, and timezone"))
            }
            const type = params.type ?? "reminder"
            yield* ctx.ask({
              permission: "reminder",
              patterns: ["*"],
              always: ["*"],
              metadata: { action: "create", type, scheduleAt: params.scheduleAt, timezone: params.timezone },
            })
            const saved = yield* scheduler
              .create({
                workspaceID: session.workspaceID,
                profileID: profile.id,
                sessionID: session.id,
                type,
                title: params.title,
                body: params.body,
                scheduleAt: params.scheduleAt,
                timezone: params.timezone,
              })
              .pipe(Effect.mapError((error) => new Error(error.message)))
            return {
              title: "Reminder created",
              metadata: { id: saved.id, status: saved.status },
              output: `Created [${saved.id}] for ${saved.scheduleAt} ${saved.timezone}`,
            }
          }

          if (!params.id) return yield* Effect.fail(new Error(`${params.action} requires an id`))
          yield* ctx.ask({
            permission: "reminder",
            patterns: ["*"],
            always: ["*"],
            metadata: { action: params.action, id: params.id },
          })

          if (params.action === "cancel") {
            yield* scheduler.cancel(params.id)
            return {
              title: "Reminder cancelled",
              metadata: { id: params.id, status: "cancelled" },
              output: `Cancelled [${params.id}]`,
            }
          }

          const updated = yield* scheduler.update({
            id: params.id,
            title: params.title,
            body: params.body,
            scheduleAt: params.scheduleAt,
            timezone: params.timezone,
            paused: params.paused,
          })
          if (!updated) return yield* Effect.fail(new Error(`Reminder not found or no longer editable: ${params.id}`))
          return {
            title: "Reminder updated",
            metadata: { id: updated.id, status: updated.status },
            output: `Updated [${updated.id}] (${updated.status})`,
          }
        }),
    }
  }),
)
