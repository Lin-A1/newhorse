import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { WorkbenchTodoTable } from "@newhorse/core/workbench/sql"
import { and, desc, eq, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Identifier } from "@newhorse/core/id/id"
import { WorkspaceV2 } from "@newhorse/core/workspace"

export const Todo = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  workspace_id: Schema.optional(WorkspaceV2.ID),
  profile_id: Schema.optional(Schema.String),
  content: Schema.String,
  status: Schema.Literals(["open", "in_progress", "done", "cancelled"]),
  priority: Schema.Literals(["low", "medium", "high"]),
  deadline: Schema.optional(Schema.Number),
  source: Schema.Literals(["user", "newhorse", "reminder"]),
  time_created: Schema.Number,
  time_updated: Schema.Number,
})
export type Todo = Schema.Schema.Type<typeof Todo>

type TodoRow = {
  id: string
  directory: string
  content: string
  status: Todo["status"]
  priority: Todo["priority"]
  source: Todo["source"]
  time_created: number
  time_updated: number
  workspace_id?: WorkspaceV2.ID | null
  profile_id?: string | null
  deadline?: number | null
}

export const CreateInput = Schema.Struct({
  directory: Schema.String,
  workspace_id: Schema.optional(WorkspaceV2.ID),
  profile_id: Schema.optional(Schema.String),
  content: Schema.String,
  priority: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  deadline: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Literals(["user", "newhorse", "reminder"])),
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const UpdateInput = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  content: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["open", "in_progress", "done", "cancelled"])),
  priority: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  deadline: Schema.optional(Schema.Number),
})
export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>

export const ListInput = Schema.Struct({
  directory: Schema.String,
  status: Schema.optional(Schema.Literals(["open", "in_progress", "done", "cancelled"])),
})
export type ListInput = Schema.Schema.Type<typeof ListInput>

// DeskAware tasks.json-style state machine: open → in_progress → done /
// cancelled. done/cancelled are terminal; only open/in_progress can reopen.
const TRANSITIONS: Record<Todo["status"], readonly Todo["status"][]> = {
  open: ["in_progress", "done", "cancelled"],
  in_progress: ["done", "cancelled", "open"],
  done: [],
  cancelled: [],
}

function isValidTransition(from: Todo["status"], to: Todo["status"]): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

export interface Interface {
  readonly list: (input: ListInput) => Effect.Effect<Todo[]>
  readonly listOpen: (limit: number) => Effect.Effect<Todo[]>
  readonly create: (input: CreateInput) => Effect.Effect<Todo, Error>
  readonly update: (input: UpdateInput) => Effect.Effect<Todo | undefined, Error>
  readonly remove: (input: { id: string; directory: string }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Workbench") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const rowToTodo = (row: TodoRow): Todo => ({
      id: row.id,
      directory: row.directory,
      workspace_id: row.workspace_id ?? undefined,
      profile_id: row.profile_id ?? undefined,
      content: row.content,
      status: row.status,
      priority: row.priority,
      deadline: row.deadline ?? undefined,
      source: row.source,
      time_created: row.time_created,
      time_updated: row.time_updated,
    })

    const list = Effect.fn("Workbench.list")(function* (input: ListInput) {
      const rows = yield* db
        .select()
        .from(WorkbenchTodoTable)
        .where(
          and(
            eq(WorkbenchTodoTable.directory, input.directory),
            input.status ? eq(WorkbenchTodoTable.status, input.status) : undefined,
          ),
        )
        .orderBy(desc(WorkbenchTodoTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToTodo)
    })

    // Cross-directory open todos, newest first. Used for Companion prompt
    // injection so newhorse can see workbench todos created in any project
    // workspace (the Companion session lives in the personal workspace, so a
    // directory-scoped query would always miss them).
    const listOpen = Effect.fn("Workbench.listOpen")(function* (limit: number) {
      const rows = yield* db
        .select()
        .from(WorkbenchTodoTable)
        .where(or(eq(WorkbenchTodoTable.status, "open"), eq(WorkbenchTodoTable.status, "in_progress")))
        .orderBy(desc(WorkbenchTodoTable.time_updated))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToTodo)
    })

    const create = Effect.fn("Workbench.create")(function* (input: CreateInput) {
      const content = input.content.trim()
      if (!content) return yield* Effect.fail(new Error("Todo content must not be empty"))
      const id = Identifier.create("wbt", "ascending")
      const row = {
        id,
        directory: input.directory,
        workspace_id: input.workspace_id,
        profile_id: input.profile_id,
        content,
        status: "open" as const,
        priority: input.priority ?? ("medium" as const),
        deadline: input.deadline,
        source: input.source ?? ("user" as const),
        time_created: Date.now(),
        time_updated: Date.now(),
      }
      yield* db.insert(WorkbenchTodoTable).values(row).run().pipe(Effect.orDie)
      return rowToTodo(row)
    })

    const update = Effect.fn("Workbench.update")(function* (input: UpdateInput) {
      const existing = yield* db
        .select()
        .from(WorkbenchTodoTable)
        .where(and(eq(WorkbenchTodoTable.id, input.id), eq(WorkbenchTodoTable.directory, input.directory)))
        .get()
        .pipe(Effect.orDie)
      if (!existing) return undefined

      const nextStatus = input.status ?? existing.status
      if (!isValidTransition(existing.status, nextStatus)) {
        return yield* Effect.fail(
          new Error(`Invalid status transition: ${existing.status} → ${nextStatus}`),
        )
      }
      const next: Partial<typeof WorkbenchTodoTable.$inferInsert> = {
        status: nextStatus,
        content: input.content?.trim() || existing.content,
        priority: input.priority ?? existing.priority,
        deadline: input.deadline ?? existing.deadline,
        time_updated: Date.now(),
      }
      yield* db
        .update(WorkbenchTodoTable)
        .set(next)
        .where(and(eq(WorkbenchTodoTable.id, input.id), eq(WorkbenchTodoTable.directory, input.directory)))
        .run()
        .pipe(Effect.orDie)
      const updated = yield* db
        .select()
        .from(WorkbenchTodoTable)
        .where(eq(WorkbenchTodoTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      return updated ? rowToTodo(updated) : undefined
    })

    const remove = Effect.fn("Workbench.remove")(function* (input: { id: string; directory: string }) {
      const existing = yield* db
        .select({ id: WorkbenchTodoTable.id })
        .from(WorkbenchTodoTable)
        .where(and(eq(WorkbenchTodoTable.id, input.id), eq(WorkbenchTodoTable.directory, input.directory)))
        .get()
        .pipe(Effect.orDie)
      if (!existing) return false
      yield* db
        .delete(WorkbenchTodoTable)
        .where(and(eq(WorkbenchTodoTable.id, input.id), eq(WorkbenchTodoTable.directory, input.directory)))
        .run()
        .pipe(Effect.orDie)
      return true
    })

    return Service.of({ list, listOpen, create, update, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as Workbench from "./index"
