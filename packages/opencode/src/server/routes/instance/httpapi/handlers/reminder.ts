import { Scheduler } from "@/scheduler"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const reminderHandlers = HttpApiBuilder.group(InstanceHttpApi, "reminder", (handlers) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service

    return handlers
      .handle("list", () => scheduler.list())
      .handle("create", (ctx) =>
        scheduler
          .create({
            profileID: ctx.payload.profileID,
            sessionID: ctx.payload.sessionID as any,
            type: ctx.payload.type,
            title: ctx.payload.title,
            body: ctx.payload.body,
            scheduleAt: ctx.payload.scheduleAt,
            timezone: ctx.payload.timezone,
          })
          .pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      .handle("update", (ctx) =>
        scheduler
          .update({ id: ctx.params.reminderID, ...ctx.payload })
          .pipe(
            Effect.flatMap((result) =>
              result ? Effect.succeed(result) : Effect.fail(new HttpApiError.BadRequest({})),
            ),
          ),
      )
      .handle("cancel", (ctx) => scheduler.cancel(ctx.params.reminderID).pipe(Effect.as(true)))
  }),
)
