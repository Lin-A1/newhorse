import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { TrustPolicy } from "@/trust-policy"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/policy-audit"

const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optional(Schema.String),
})

export const PolicyAuditApi = HttpApi.make("policy-audit").add(
  HttpApiGroup.make("policy-audit")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: ListQuery,
        success: described(TrustPolicy.Page, "Content-free policy audit page"),
      }).annotateMerge(OpenApi.annotations({ identifier: "policyAudit.list", summary: "List content-flow policy audit records" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "policy-audit", description: "Content-free Trust Policy audit trail." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
