export * as SchedulerEvent from "./scheduler-event"

import { Event } from "./event"
import { Schema } from "effect"
import { Workspace } from "./workspace"

export const Due = Event.define({
  type: "scheduled-event.due",
  schema: {
    id: Schema.String,
    workspaceID: Schema.optional(Workspace.ID),
    profileID: Schema.String,
    sessionID: Schema.optional(Schema.String),
    eventType: Schema.Literals(["reminder", "check_in", "follow_up", "follow"]),
    title: Schema.String,
    body: Schema.String,
    scheduleAt: Schema.Int,
    occurrenceAt: Schema.Int,
    deliveryKey: Schema.String,
    attemptCount: Schema.Int,
  },
})

export const Definitions = Event.inventory(Due)
