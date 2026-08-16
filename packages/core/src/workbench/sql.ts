import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { WorkspaceV2 } from "../workspace"

export type WorkbenchTodoStatus = "open" | "in_progress" | "done" | "cancelled"
export type WorkbenchTodoPriority = "low" | "medium" | "high"
export type WorkbenchTodoSource = "user" | "newhorse" | "reminder"

export const WorkbenchTodoTable = sqliteTable(
  "workbench_todo",
  {
    id: text().primaryKey(),
    // Instance-local scoping (mirrors sessions). `directory` is the authority
    // key; optional workspace/profile bindings are hints for later placement.
    directory: text().notNull(),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    profile_id: text(),
    content: text().notNull(),
    status: text().$type<WorkbenchTodoStatus>().notNull().default("open"),
    priority: text().$type<WorkbenchTodoPriority>().notNull().default("medium"),
    deadline: integer(),
    source: text().$type<WorkbenchTodoSource>().notNull().default("user"),
    ...Timestamps,
  },
  (table) => [
    index("workbench_todo_directory_status_idx").on(table.directory, table.status),
    index("workbench_todo_workspace_idx").on(table.workspace_id),
  ],
)
