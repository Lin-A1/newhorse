import { ContinuityGrant } from "@/continuity-grant"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, ConflictError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/continuity-grant"

const Propose = Schema.Struct({
  destinationSessionID: SessionID,
  purpose: Schema.String,
  summary: Schema.String,
  timeExpires: Schema.Int,
})

export const ContinuityGrantApi = HttpApi.make("continuityGrant").add(
  HttpApiGroup.make("continuityGrant")
    .add(
      HttpApiEndpoint.post("propose", root, {
        query: WorkspaceRoutingQuery,
        payload: Propose,
        success: described(ContinuityGrant.Info, "Created continuity grant proposal"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "continuityGrant.propose", summary: "Propose continuity grant" }),
      ),
      HttpApiEndpoint.get("list", root, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(ContinuityGrant.Info), "Source session continuity grants"),
        error: ApiNotFoundError,
      }).annotateMerge(OpenApi.annotations({ identifier: "continuityGrant.list", summary: "List continuity grants" })),
      HttpApiEndpoint.get("get", `${root}/:grantID`, {
        params: { grantID: ContinuityGrant.ID },
        query: WorkspaceRoutingQuery,
        success: described(ContinuityGrant.Info, "Continuity grant"),
        error: ApiNotFoundError,
      }).annotateMerge(OpenApi.annotations({ identifier: "continuityGrant.get", summary: "Get continuity grant" })),
      HttpApiEndpoint.get("audit", `${root}/:grantID/audit`, {
        params: { grantID: ContinuityGrant.ID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(ContinuityGrant.AuditInfo), "Content-free continuity grant audit"),
        error: ApiNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "continuityGrant.audit", summary: "Get continuity grant audit" }),
      ),
      HttpApiEndpoint.post("approve", `${root}/:grantID/approve`, {
        params: { grantID: ContinuityGrant.ID },
        query: WorkspaceRoutingQuery,
        success: described(ContinuityGrant.Info, "Approved continuity grant"),
        error: [ApiNotFoundError, ConflictError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "continuityGrant.approve", summary: "Approve continuity grant" }),
      ),
      HttpApiEndpoint.post("revoke", `${root}/:grantID/revoke`, {
        params: { grantID: ContinuityGrant.ID },
        query: WorkspaceRoutingQuery,
        success: described(ContinuityGrant.Info, "Revoked continuity grant"),
        error: ApiNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "continuityGrant.revoke", summary: "Revoke continuity grant" }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "continuityGrant",
        description: "Explicit, minimized Assistant-to-Companion continuity grants.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
