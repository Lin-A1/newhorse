import { Scheduler } from "@/scheduler"
import { Profile } from "@/profile"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

export const reminderHandlers = HttpApiBuilder.group(InstanceHttpApi, "reminder", (handlers) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service
    const profiles = yield* Profile.Service

    return handlers
      .handle("list", () => scheduler.list())
      .handle("create", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          const profileID = route.profileID ?? (yield* profiles.activeID())
          return yield* scheduler
            .create({
              profileID,
              sessionID: route.sessionID,
              type: ctx.payload.type,
              title: ctx.payload.title,
              body: ctx.payload.body,
              scheduleAt: ctx.payload.scheduleAt,
              timezone: ctx.payload.timezone,
              recurrenceRule: ctx.payload.recurrenceRule,
              misfirePolicy: ctx.payload.misfirePolicy,
            })
            .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
        }),
      )
      .handle("update", (ctx) =>
        scheduler
          .update({
            id: ctx.params.reminderID,
            ...ctx.payload,
            recurrenceRule: ctx.payload.clearRecurrence ? null : ctx.payload.recurrenceRule,
          })
          .pipe(
            Effect.mapError(() => new HttpApiError.BadRequest({})),
            Effect.flatMap((result) =>
              result ? Effect.succeed(result) : Effect.fail(new HttpApiError.BadRequest({})),
            ),
          ),
      )
      .handle("audit", (ctx) =>
        Effect.gen(function* () {
          const parsed = ctx.query.limit === undefined ? undefined : Number.parseInt(ctx.query.limit, 10)
          const limit = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined
          const page = yield* scheduler.audit(ctx.params.reminderID, { limit, cursor: ctx.query.cursor })
          return yield* page
            ? Effect.succeed(page)
            : Effect.fail(new HttpApiError.NotFound({}))
        }),
      )
      .handle("cancel", (ctx) => scheduler.cancel(ctx.params.reminderID))
  }),
)
