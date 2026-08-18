import { Presence } from "@/presence"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/presence"

export const PresenceApi = HttpApi.make("presence").add(
  HttpApiGroup.make("presence")
    .add(
      HttpApiEndpoint.get("current", root, {
        success: described(Presence.Info, "Current bounded presence"),
      }).annotateMerge(OpenApi.annotations({ identifier: "presence.current", summary: "Get current presence" })),
      HttpApiEndpoint.get("timeline", `${root}/timeline`, {
        success: described(Presence.Timeline, "Today's focus-app timeline"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "presence.timeline",
          summary: "Get today's focus-app timeline",
          description: "Today's OS foreground-app segments (Gantt rows) reported by the desktop host.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post(
        "update",
        root,
        {
          payload: Presence.Extras,
          success: described(Schema.Void, "Presence updated"),
        },
      ).annotateMerge(OpenApi.annotations({ identifier: "presence.update", summary: "Report desktop presence signal" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "presence", description: "Bounded host presence." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
