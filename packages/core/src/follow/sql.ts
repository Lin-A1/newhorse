import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { WorkspaceV2 } from "../workspace"

export type FollowKind = "topic" | "deadline" | "release" | "price"
export type FollowStatus = "active" | "paused"

// A "follow point": something the Companion watches on the user's behalf and
// notifies them about when it changes — e.g. a topic (via web search), a
// deadline (countdown), a repo release, or a price. Change-driven proactivity,
// unlike reminders which are time-driven.
export const FollowTable = sqliteTable(
  "follow",
  {
    id: text().primaryKey(),
    // Personal/companion scope. workspace_id is null (companion reminders live
    // in the personal scope).
    workspace_id: text().$type<WorkspaceV2.ID>(),
    directory: text(),
    scope: text().notNull().default("personal"),
    profile_id: text(),
    kind: text().$type<FollowKind>().notNull(),
    // What the user asked to follow ("deepseek V4", "repo X new release").
    topic: text().notNull(),
    check_interval_minutes: integer().notNull().default(60),
    // Last observed result; used for change detection. Null before first check.
    last_value: text(),
    last_checked_at: integer(),
    status: text().$type<FollowStatus>().notNull().default("active"),
    ...Timestamps,
  },
  (table) => [
    index("follow_profile_idx").on(table.profile_id),
    index("follow_scope_status_idx").on(table.scope, table.status),
  ],
)
