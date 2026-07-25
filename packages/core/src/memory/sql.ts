import { sqliteTable, text, integer, index, real } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { WorkspaceV2 } from "../workspace"
import type { SessionSchema } from "../session/schema"

export type MemoryScope = "workspace" | "user_global"
export type MemoryKind = "preference" | "fact" | "goal" | "event" | "relationship" | "summary"
export type MemoryProvenance = "user_explicit" | "user_confirmed" | "model_inferred"
export type MemorySensitivity = "normal" | "sensitive"
export type MemoryStatus = "proposed" | "active" | "rejected" | "deleted"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().primaryKey(),
    // Primary isolation key. Null only when scope is user_global.
    workspace_id: text().$type<WorkspaceV2.ID>(),
    scope: text().$type<MemoryScope>().notNull(),
    profile_id: text(),
    kind: text().$type<MemoryKind>().notNull(),
    content: text().notNull(),
    source_session_id: text().$type<SessionSchema.ID>(),
    source_message_id: text(),
    provenance: text().$type<MemoryProvenance>().notNull(),
    confidence: real(),
    sensitivity: text().$type<MemorySensitivity>().notNull().default("normal"),
    status: text().$type<MemoryStatus>().notNull().default("proposed"),
    ...Timestamps,
    time_expires: integer(),
  },
  (table) => [
    index("memory_workspace_idx").on(table.workspace_id),
    index("memory_scope_idx").on(table.scope),
    index("memory_status_idx").on(table.status),
  ],
)
