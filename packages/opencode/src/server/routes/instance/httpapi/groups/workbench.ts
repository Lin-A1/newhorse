import { Workbench } from "@/workbench"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workbench/todo"

const CreatePayload = Schema.Struct({
  content: Schema.String,
  priority: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  deadline: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Literals(["user", "newhorse", "reminder"])),
})

const UpdatePayload = Schema.Struct({
  content: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["open", "in_progress", "done", "cancelled"])),
  priority: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  deadline: Schema.optional(Schema.Number),
})

export const WorkbenchApi = HttpApi.make("workbench").add(
  HttpApiGroup.make("workbench")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Workbench.Todo), "Workbench todos"),
      }).annotateMerge(OpenApi.annotations({ identifier: "workbench.list", summary: "List workbench todos" })),
      HttpApiEndpoint.post("create", root, {
        query: WorkspaceRoutingQuery,
        payload: CreatePayload,
        success: described(Workbench.Todo, "Created workbench todo"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "workbench.create", summary: "Create workbench todo" })),
      HttpApiEndpoint.patch("update", `${root}/:todoID`, {
        params: { todoID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: UpdatePayload,
        success: described(Workbench.Todo, "Updated workbench todo"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "workbench.update", summary: "Update workbench todo" })),
      HttpApiEndpoint.delete("remove", `${root}/:todoID`, {
        params: { todoID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Workbench todo removed"),
      }).annotateMerge(OpenApi.annotations({ identifier: "workbench.remove", summary: "Remove workbench todo" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "workbench", description: "Personal workbench todos." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
