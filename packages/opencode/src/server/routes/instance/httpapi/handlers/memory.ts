import { Memory } from "@/memory"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

const badRequest = () => new HttpApiError.BadRequest({})

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return handlers
      .handle("list", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* memory.page({
            status: ctx.query.status ? [...ctx.query.status] : undefined,
            includeGlobal: ctx.query.includeGlobal,
            profileID: route.profileID,
            limit: ctx.query.limit,
            cursor: ctx.query.cursor,
          })
        }),
      )
      .handle("update", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* memory
            .update({
              id: ctx.params.memoryID,
              scope: ctx.payload.scope,
              kind: ctx.payload.kind,
              content: ctx.payload.content,
              expiresAt: ctx.payload.clearExpiry ? null : ctx.payload.expiresAt,
              profileID: route.profileID,
            })
            .pipe(
              Effect.mapError(badRequest),
              Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.fail(badRequest()))),
            )
        }),
      )
      .handle("decide", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* memory
            .decide({
              id: ctx.params.memoryID,
              scope: ctx.payload.scope,
              decision: ctx.payload.decision,
              profileID: route.profileID,
            })
            .pipe(Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.fail(badRequest()))))
        }),
      )
      .handle("pause", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* memory
            .pause({
              id: ctx.params.memoryID,
              scope: ctx.payload.scope,
              paused: ctx.payload.paused,
              profileID: route.profileID,
            })
            .pipe(Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.fail(badRequest()))))
        }),
      )
      .handle("remove", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* memory
            .forget(ctx.params.memoryID, ctx.query.scope, route.profileID)
            .pipe(Effect.flatMap((removed) => (removed ? Effect.succeed(true) : Effect.fail(badRequest()))))
        }),
      )
      .handle("export", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* memory.export({
            includeGlobal: ctx.query.includeGlobal,
            profileID: route.profileID,
          })
        }),
      )
      .handle("clear", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* memory.clear({ target: ctx.payload.target, profileID: route.profileID }).pipe(
            Effect.map((cleared) => ({ cleared })),
            Effect.mapError(badRequest),
          )
        }),
      )
  }),
)
