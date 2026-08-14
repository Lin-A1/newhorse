import { sqliteTable, text, integer, index, real } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { WorkspaceV2 } from "../workspace"
import type { SessionSchema } from "../session/schema"

export type MemoryScope = "project" | "personal" | "relationship" | "user_global"
export type MemoryKind = "preference" | "fact" | "goal" | "event" | "relationship" | "summary"
export type MemoryProvenance = "user_explicit" | "user_confirmed" | "model_inferred"
export type MemorySensitivity = "normal" | "sensitive"
export type MemoryStatus = "proposed" | "active" | "paused" | "rejected" | "deleted"
export type MemoryHistoryEvent = "ADD" | "UPDATE" | "DELETE" | "ACCEPT" | "REJECT" | "PAUSE" | "RESUME" | "CLEAR"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().primaryKey(),
    // Primary isolation key. Null only when scope is user_global.
    workspace_id: text().$type<WorkspaceV2.ID>(),
    directory: text(),
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
    index("memory_directory_idx").on(table.directory),
    index("memory_scope_idx").on(table.scope),
    index("memory_status_idx").on(table.status),
    index("memory_scope_owner_profile_status_time_idx").on(
      table.scope,
      table.workspace_id,
      table.directory,
      table.profile_id,
      table.status,
      table.time_created,
      table.id,
    ),
    index("memory_relationship_profile_status_idx").on(table.kind, table.profile_id, table.status),
  ],
)

// Lightweight implicit graph: entities extracted from memory content at write
// time (proper nouns, quoted phrases, technical identifiers, topic phrases).
// Search boosts memories whose stored entities match entities extracted from
// the query. Owned by the memory row: FK cascade clears entities when the
// memory is forgotten, cleared, or pruned by maintain.
export const MemoryEntityTable = sqliteTable(
  "memory_entity",
  {
    id: text().primaryKey(),
    memory_id: text()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    entity_text: text().notNull(),
    entity_type: text().notNull(),
    normalized_text: text().notNull(),
  },
  (table) => [
    index("memory_entity_memory_idx").on(table.memory_id),
    index("memory_entity_normalized_idx").on(table.normalized_text, table.memory_id),
  ],
)

// Audit log of memory lifecycle transitions. Intentionally has NO foreign key:
// it must survive the physical deletion of its memory row (forget/clear, and
// maintain's 30-day pruning of rejected/deleted rows). old_content/new_content
// capture the content delta for UPDATE so the log is self-contained.
export const MemoryHistoryTable = sqliteTable(
  "memory_history",
  {
    id: text().primaryKey(),
    memory_id: text(),
    old_content: text(),
    new_content: text(),
    event: text().$type<MemoryHistoryEvent>().notNull(),
    actor_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("memory_history_memory_idx").on(table.memory_id),
    index("memory_history_created_at_idx").on(table.created_at),
  ],
)
