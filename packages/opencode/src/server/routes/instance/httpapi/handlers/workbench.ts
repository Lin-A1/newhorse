import { Workbench } from "@/workbench"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

export const workbenchHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench", (handlers) =>
  Effect.gen(function* () {
    const workbench = yield* Workbench.Service

    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* workbench.list({ directory: route.directory })
        }),
      )
      .handle("create", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* workbench
            .create({
              ...ctx.payload,
              directory: route.directory,
              workspace_id: route.workspaceID,
            })
            .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
        }),
      )
      .handle("update", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          const updated = yield* workbench
            .update({ ...ctx.payload, id: ctx.params.todoID, directory: route.directory })
            .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
          if (!updated) return yield* new HttpApiError.BadRequest({})
          return updated
        }),
      )
      .handle("remove", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* workbench.remove({ id: ctx.params.todoID, directory: route.directory })
        }),
      )
  }),
)
