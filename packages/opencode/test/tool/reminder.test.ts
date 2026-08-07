import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { SessionProjector } from "@newhorse/core/session/projector"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Profile } from "@/profile"
import { Scheduler } from "@/scheduler"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { ReminderTool } from "@/tool/reminder"
import { Truncate } from "@/tool/truncate"
import type * as Tool from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Scheduler.node, Session.node, SessionProjector.node, Profile.node, Truncate.node, Agent.node]),
  ),
)

describe("tool.reminder", () => {
  it.instance("creates explicit reminders without ask and asks for update and cancel", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const scheduler = yield* Scheduler.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })
      const info = yield* ReminderTool
      const tool = yield* info.init()
      const asked: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx = {
        sessionID: session.id,
        messageID: MessageID.make("msg_reminder_test"),
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (request) => Effect.sync(() => void asked.push(request)),
      } satisfies Tool.Context

      const empty = yield* tool.execute({ action: "list" }, ctx)
      expect(empty.output).toBe("No reminders stored.")
      expect(asked).toEqual([])

      const now = Date.now() + 60_000
      const created = yield* tool.execute(
        {
          action: "create",
          title: "Drink water",
          body: "Take a water break",
          scheduleAt: now,
          timezone: "UTC",
        },
        ctx,
      )
      // Explicit user-requested reminders are created without a permission prompt.
      expect(asked).toEqual([])
      const id = Scheduler.ID.make(created.metadata.id!)
      expect((yield* scheduler.list())[0]).toMatchObject({ id, title: "Drink water", status: "pending" })

      yield* tool.execute({ action: "update", id, paused: true }, ctx)
      expect(asked[0]).toMatchObject({ permission: "reminder", metadata: { action: "update", id } })
      expect((yield* scheduler.list())[0]?.status).toBe("paused")

      yield* tool.execute({ action: "cancel", id }, ctx)
      expect(asked[1]).toMatchObject({ permission: "reminder", metadata: { action: "cancel", id } })
      expect((yield* scheduler.list())[0]?.status).toBe("cancelled")
    }),
  )

  it.instance("keeps validation errors recoverable", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })
      const info = yield* ReminderTool
      const tool = yield* info.init()
      const error = yield* tool
        .execute(
          { action: "create" },
          {
            sessionID: session.id,
            messageID: MessageID.make("msg_reminder_invalid"),
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("create requires title, body, scheduleAt, and timezone")
    }),
  )

  it.instance("delegates proactive consent validation to the scheduler", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const profiles = yield* Profile.Service
      yield* profiles.update(Profile.ID.make("companion"), { proactive: false, proactivePaused: false })
      const session = yield* sessions.create({ profileID: Profile.ID.make("companion") })
      const info = yield* ReminderTool
      const tool = yield* info.init()
      let asked = false
      const exit = yield* tool
        .execute(
          {
            action: "create",
            type: "check_in",
            title: "Check in",
            body: "How are you?",
            scheduleAt: Date.now() + 60_000,
            timezone: "UTC",
          },
          {
            sessionID: session.id,
            messageID: MessageID.make("msg_reminder_unsubscribed"),
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () =>
              Effect.sync(() => {
                asked = true
              }),
          },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(asked).toBe(true)
    }),
  )
})
