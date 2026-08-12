import { Memory } from "@/memory"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

const root = "/memory"

const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  status: Schema.optional(Schema.Array(Memory.Status)),
  includeGlobal: Schema.optional(QueryBoolean),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optional(Schema.String),
})

const ExportQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  includeGlobal: Schema.optional(QueryBoolean),
})
const RoutingQuery = Schema.Struct(WorkspaceRoutingQueryFields)
const RemoveQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Memory.Scope),
})

const Update = Schema.Struct({
  scope: Schema.optional(Memory.Scope),
  kind: Schema.optional(Memory.Kind),
  content: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Int),
  clearExpiry: Schema.optional(Schema.Boolean),
})

const Decision = Schema.Struct({
  scope: Schema.optional(Memory.Scope),
  decision: Schema.Literals(["accept", "reject"]),
})

const Pause = Schema.Struct({
  scope: Schema.optional(Memory.Scope),
  paused: Schema.Boolean,
})

const Clear = Schema.Struct({
  target: Schema.Literals(["workspace", "relationship", "user_global"]),
})

const Cleared = Schema.Struct({ cleared: Schema.Int })

export const MemoryApi = HttpApi.make("memory").add(
  HttpApiGroup.make("memory")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: ListQuery,
        success: described(Memory.Page, "Paginated Memory records"),
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.list", summary: "List Memory records" })),
      HttpApiEndpoint.patch("update", `${root}/:memoryID`, {
        params: { memoryID: Schema.String },
        query: RoutingQuery,
        payload: Update,
        success: described(Memory.Info, "Updated Memory record"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.update", summary: "Update a Memory record" })),
      HttpApiEndpoint.post("decide", `${root}/:memoryID/decision`, {
        params: { memoryID: Schema.String },
        query: RoutingQuery,
        payload: Decision,
        success: described(Memory.Info, "Decided Memory proposal"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.decide", summary: "Accept or reject a proposal" })),
      HttpApiEndpoint.post("pause", `${root}/:memoryID/pause`, {
        params: { memoryID: Schema.String },
        query: RoutingQuery,
        payload: Pause,
        success: described(Memory.Info, "Paused or resumed Memory record"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.pause", summary: "Pause or resume Memory" })),
      HttpApiEndpoint.delete("remove", `${root}/:memoryID`, {
        params: { memoryID: Schema.String },
        query: RemoveQuery,
        success: described(Schema.Boolean, "Memory record removed"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.remove", summary: "Remove a Memory record" })),
      HttpApiEndpoint.get("export", `${root}/export`, {
        query: ExportQuery,
        success: described(Schema.Array(Memory.Info), "Exported visible Memory records"),
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.export", summary: "Export Memory records" })),
      HttpApiEndpoint.get("history", `${root}/:memoryID/history`, {
        params: { memoryID: Schema.String },
        query: RoutingQuery,
        success: described(Schema.Array(Memory.HistoryInfo), "Audit history for a Memory record"),
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.history", summary: "Get Memory audit history" })),
      HttpApiEndpoint.post("clear", `${root}/clear`, {
        query: RoutingQuery,
        payload: Clear,
        success: described(Cleared, "Cleared Memory records"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "memory.clear", summary: "Clear a Memory scope" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "memory", description: "Scoped long-term Memory management." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
