import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { SessionSchema } from "../session/schema"
import type { WorkspaceV2 } from "../workspace"

export type ContinuityGrantStatus = "proposed" | "active" | "revoked"
export type ContinuityGrantAuditAction = "proposed" | "approved" | "injected" | "revoked"

export const ContinuityGrantTable = sqliteTable(
  "continuity_grant",
  {
    id: text().primaryKey(),
    source_workspace_id: text().$type<WorkspaceV2.ID>(),
    source_directory: text().notNull(),
    source_profile_id: text().notNull(),
    source_session_id: text().$type<SessionSchema.ID>().notNull(),
    destination_workspace_id: text().$type<WorkspaceV2.ID>().notNull(),
    destination_directory: text().notNull(),
    destination_profile_id: text().notNull(),
    destination_session_id: text().$type<SessionSchema.ID>().notNull(),
    purpose: text().notNull(),
    summary: text().notNull(),
    relationship_persistence: integer({ mode: "boolean" }).notNull().default(false),
    time_expires: integer().notNull(),
    status: text().$type<ContinuityGrantStatus>().notNull().default("proposed"),
    time_approved: integer(),
    time_revoked: integer(),
    ...Timestamps,
  },
  (table) => [
    index("continuity_grant_source_idx").on(table.source_session_id, table.time_created, table.id),
    index("continuity_grant_destination_idx").on(
      table.destination_session_id,
      table.destination_workspace_id,
      table.destination_profile_id,
      table.status,
      table.time_expires,
    ),
  ],
)

export const ContinuityGrantAuditTable = sqliteTable(
  "continuity_grant_audit",
  {
    id: text().primaryKey(),
    grant_id: text()
      .notNull()
      .references(() => ContinuityGrantTable.id, { onDelete: "cascade" }),
    action: text().$type<ContinuityGrantAuditAction>().notNull(),
    outcome: text().notNull(),
    reason: text(),
    destination_session_id: text().$type<SessionSchema.ID>(),
    time_created: integer().notNull(),
  },
  (table) => [index("continuity_grant_audit_idx").on(table.grant_id, table.time_created, table.id)],
)
