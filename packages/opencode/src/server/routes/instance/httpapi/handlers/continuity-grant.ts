import { ContinuityGrant } from "@/continuity-grant"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConflictError, notFound } from "../errors"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

const sourceSession = Effect.gen(function* () {
  const route = yield* WorkspaceRouteContext
  return yield* route.sessionID ? Effect.succeed(route.sessionID) : Effect.fail(notFound("Source session not found"))
})

const owned = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) =>
  effect.pipe(
    Effect.flatMap((value) => (value ? Effect.succeed(value) : Effect.fail(notFound("Continuity grant not found")))),
  )

export const continuityGrantHandlers = HttpApiBuilder.group(InstanceHttpApi, "continuityGrant", (handlers) =>
  Effect.gen(function* () {
    const continuity = yield* ContinuityGrant.Service

    return handlers
      .handle("propose", (ctx) =>
        Effect.gen(function* () {
          const sourceSessionID = yield* sourceSession
          return yield* continuity
            .propose({
              sourceSessionID,
              destinationSessionID: ctx.payload.destinationSessionID,
              purpose: ctx.payload.purpose,
              summary: ctx.payload.summary,
              timeExpires: ctx.payload.timeExpires,
            })
            .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
        }),
      )
      .handle("list", () =>
        Effect.gen(function* () {
          const sourceSessionID = yield* sourceSession
          return yield* continuity.listSource(sourceSessionID)
        }),
      )
      .handle("get", (ctx) =>
        Effect.gen(function* () {
          const sourceSessionID = yield* sourceSession
          return yield* owned(continuity.getSource({ sourceSessionID, id: ctx.params.grantID }))
        }),
      )
      .handle("audit", (ctx) =>
        Effect.gen(function* () {
          const sourceSessionID = yield* sourceSession
          return yield* owned(continuity.auditSource({ sourceSessionID, id: ctx.params.grantID }))
        }),
      )
      .handle("approve", (ctx) =>
        Effect.gen(function* () {
          const sourceSessionID = yield* sourceSession
          return yield* continuity.approve({ sourceSessionID, id: ctx.params.grantID }).pipe(
            Effect.mapError((error) => new ConflictError({ message: error.message, resource: "continuity_grant" })),
            owned,
          )
        }),
      )
      .handle("revoke", (ctx) =>
        Effect.gen(function* () {
          const sourceSessionID = yield* sourceSession
          return yield* owned(continuity.revokeSource({ sourceSessionID, id: ctx.params.grantID }))
        }),
      )
  }),
)
