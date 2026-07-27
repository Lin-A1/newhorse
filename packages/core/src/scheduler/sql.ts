import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { Timestamps } from "../database/schema.sql"
import type { WorkspaceV2 } from "../workspace"
import type { SessionSchema } from "../session/schema"

export type ScheduledEventType = "reminder" | "check_in" | "follow_up"
export type ScheduledEventStatus = "pending" | "paused" | "delivered" | "cancelled" | "failed"
export type ScheduledEventAuditAction =
  | "created"
  | "updated"
  | "paused"
  | "resumed"
  | "cancelled"
  | "claimed"
  | "deferred"
  | "delivered"
  | "failed"
  | "recovered"

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
    timezone: text().notNull(),
    status: text().$type<ScheduledEventStatus>().notNull().default("pending"),
    lease_owner: text(),
    lease_expires_at: integer(),
    attempt_count: integer().notNull().default(0),
    last_error: text(),
    last_fired_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("scheduled_event_due_idx").on(table.status, table.schedule_at),
    index("scheduled_event_lease_idx").on(table.lease_expires_at),
    index("scheduled_event_workspace_idx").on(table.workspace_id),
    index("scheduled_event_profile_idx").on(table.profile_id),
    uniqueIndex("scheduled_event_idempotency_idx").on(
      table.idempotency_key,
      table.profile_id,
      sql`coalesce(${table.workspace_id}, '')`,
    ),
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
    time_created: integer().notNull(),
  },
  (table) => [index("scheduled_event_audit_event_idx").on(table.event_id, table.time_created)],
)
