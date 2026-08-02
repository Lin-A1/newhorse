import { Scheduler } from "@/scheduler"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/reminder"

const Create = Schema.Struct({
  type: Schema.optional(Scheduler.Type),
  title: Schema.String,
  body: Schema.String,
  scheduleAt: Schema.Int,
  timezone: Schema.String,
  recurrenceRule: Schema.optional(Schema.String),
  misfirePolicy: Schema.optional(Schema.Literals(["catch_up_once", "skip"])),
})

const Update = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  scheduleAt: Schema.optional(Schema.Int),
  timezone: Schema.optional(Schema.String),
  recurrenceRule: Schema.optional(Schema.String),
  clearRecurrence: Schema.optional(Schema.Boolean),
  misfirePolicy: Schema.optional(Schema.Literals(["catch_up_once", "skip"])),
  paused: Schema.optional(Schema.Boolean),
})

const AuditQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
})

export const ReminderApi = HttpApi.make("reminder").add(
  HttpApiGroup.make("reminder")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Scheduler.Info), "Workspace reminders"),
      }).annotateMerge(OpenApi.annotations({ identifier: "reminder.list", summary: "List reminders" })),
      HttpApiEndpoint.post("create", root, {
        query: WorkspaceRoutingQuery,
        payload: Create,
        success: described(Scheduler.Info, "Created reminder"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "reminder.create", summary: "Create reminder" })),
      HttpApiEndpoint.patch("update", `${root}/:reminderID`, {
        params: { reminderID: Scheduler.ID },
        query: WorkspaceRoutingQuery,
        payload: Update,
        success: described(Scheduler.Info, "Updated reminder"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(OpenApi.annotations({ identifier: "reminder.update", summary: "Update reminder" })),
      HttpApiEndpoint.get("audit", `${root}/:reminderID/audit`, {
        params: { reminderID: Scheduler.ID },
        query: AuditQuery,
        success: described(Scheduler.AuditPage, "Content-minimized reminder audit page"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "reminder.audit", summary: "Get reminder audit" })),
      HttpApiEndpoint.delete("cancel", `${root}/:reminderID`, {
        params: { reminderID: Scheduler.ID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Reminder cancelled"),
      }).annotateMerge(OpenApi.annotations({ identifier: "reminder.cancel", summary: "Cancel reminder" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "reminder", description: "Persistent workspace reminders." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
