import { Presence } from "@/presence"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

export const presenceHandlers = HttpApiBuilder.group(InstanceHttpApi, "presence", (handlers) =>
  Effect.gen(function* () {
    const presence = yield* Presence.Service

    return handlers
      .handle("current", () =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          return yield* presence.get({ directory: route.directory })
        }),
      )
      .handle("update", (ctx) => presence.update(ctx.payload))
      .handle("timeline", () => presence.timeline())
  }),
)