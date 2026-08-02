import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { Timestamps } from "../database/schema.sql"
import type { WorkspaceV2 } from "../workspace"
import type { SessionSchema } from "../session/schema"

export type ScheduledEventType = "reminder" | "check_in" | "follow_up"
export type ScheduledEventStatus = "pending" | "paused" | "dispatching" | "delivered" | "cancelled" | "failed"
export type ScheduledEventMisfirePolicy = "catch_up_once" | "skip"
export type ScheduledEventDeliveryStatus = "pending" | "retry" | "delivered" | "cancelled" | "failed"
export type ScheduledEventAuditAction =
  | "created"
  | "updated"
  | "paused"
  | "resumed"
  | "cancelled"
  | "claimed"
  | "deferred"
  | "staged"
  | "skipped"
  | "delivered"
  | "failed"
  | "recovered"
  | "retry_scheduled"

export const ScheduledEventTable = sqliteTable(
  "scheduled_event",
  {
    id: text().primaryKey(),
    idempotency_key: text().notNull(),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    directory: text().notNull(),
    profile_id: text().notNull(),
    session_id: text().$type<SessionSchema.ID>(),
    type: text().$type<ScheduledEventType>().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    schedule_at: integer().notNull(),
    eligible_at: integer().notNull().default(0),
    timezone: text().notNull(),
    recurrence_rule: text(),
    recurrence_anchor_at: integer(),
    misfire_policy: text().$type<ScheduledEventMisfirePolicy>().notNull().default("catch_up_once"),
    status: text().$type<ScheduledEventStatus>().notNull().default("pending"),
    lease_owner: text(),
    lease_token: integer().notNull().default(0),
    lease_expires_at: integer(),
    attempt_count: integer().notNull().default(0),
    last_error: text(),
    last_fired_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("scheduled_event_due_idx").on(table.status, table.eligible_at),
    index("scheduled_event_lease_idx").on(table.lease_expires_at),
    index("scheduled_event_workspace_idx").on(table.workspace_id),
    index("scheduled_event_profile_idx").on(table.profile_id),
    uniqueIndex("scheduled_event_idempotency_idx").on(
      table.idempotency_key,
      table.profile_id,
      sql`coalesce(${table.workspace_id}, ${table.directory})`,
    ),
  ],
)

export const ScheduledEventDeliveryTable = sqliteTable(
  "scheduled_event_delivery",
  {
    id: text().primaryKey(),
    event_id: text()
      .notNull()
      .references(() => ScheduledEventTable.id, { onDelete: "restrict" }),
    occurrence_at: integer().notNull(),
    delivery_key: text().notNull(),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    directory: text().notNull(),
    profile_id: text().notNull(),
    session_id: text().$type<SessionSchema.ID>(),
    event_type: text().$type<ScheduledEventType>().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    status: text().$type<ScheduledEventDeliveryStatus>().notNull().default("pending"),
    available_at: integer().notNull(),
    attempt_count: integer().notNull().default(0),
    max_attempts: integer().notNull(),
    lease_owner: text(),
    lease_token: integer().notNull().default(0),
    lease_expires_at: integer(),
    last_error: text(),
    time_delivered: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("scheduled_event_delivery_occurrence_idx").on(table.event_id, table.occurrence_at),
    uniqueIndex("scheduled_event_delivery_key_idx").on(table.delivery_key),
    index("scheduled_event_delivery_available_idx").on(table.status, table.available_at),
    index("scheduled_event_delivery_lease_idx").on(table.lease_expires_at),
  ],
)

export const ScheduledEventAuditTable = sqliteTable(
  "scheduled_event_audit",
  {
    id: text().primaryKey(),
    event_id: text()
      .notNull()
      .references(() => ScheduledEventTable.id, { onDelete: "cascade" }),
    action: text().$type<ScheduledEventAuditAction>().notNull(),
    outcome: text().notNull(),
    reason: text(),
    occurrence_at: integer(),
    delivery_key: text(),
    time_created: integer().notNull(),
  },
  (table) => [index("scheduled_event_audit_event_idx").on(table.event_id, table.time_created)],
)
