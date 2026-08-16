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
    )
    .annotateMerge(OpenApi.annotations({ title: "presence", description: "Bounded host presence." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
