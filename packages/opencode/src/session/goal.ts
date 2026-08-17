import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { GoalTable, type GoalPriority, type GoalStatus } from "@newhorse/core/session/sql"
import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Identifier } from "@newhorse/core/id/id"
import { SessionID } from "./schema"

export const Status = Schema.Literals(["open", "in_progress", "blocked", "done", "cancelled"])
export type Status = Schema.Schema.Type<typeof Status>

export const Priority = Schema.Literals(["low", "medium", "high"])
export type Priority = Schema.Schema.Type<typeof Priority>

export const Info = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  status: Status,
  priority: Priority,
  deadline: Schema.optional(Schema.Number),
  done_reason: Schema.optional(Schema.String),
  time_created: Schema.Number,
  time_updated: Schema.Number,
})
export type Info = Schema.Schema.Type<typeof Info>

export type CreateInput = { sessionID: SessionID; content: string; priority?: Priority; deadline?: number }
export type UpdateInput = {
  sessionID: SessionID
  id: string
  content?: string
  status?: Status
  priority?: Priority
  deadline?: number
  done_reason?: string
}

const TRANSITIONS: Record<Status, readonly Status[]> = {
  open: ["in_progress", "blocked", "done", "cancelled"],
  in_progress: ["done", "blocked", "open"],
  blocked: ["in_progress", "open", "cancelled"],
  done: [],
  cancelled: [],
}

function isValidTransition(from: Status, to: Status): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, Error>
  readonly update: (input: UpdateInput) => Effect.Effect<Info | undefined, Error>
  readonly get: (input: { sessionID: SessionID; id: string }) => Effect.Effect<Info | undefined>
  readonly list: (input: { sessionID: SessionID; status?: Status }) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Goal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const rowToInfo = (row: typeof GoalTable.$inferSelect): Info => ({
      id: row.id,
      content: row.content,
      status: row.status,
      priority: row.priority,
      deadline: row.deadline ?? undefined,
      done_reason: row.done_reason ?? undefined,
      time_created: row.time_created,
      time_updated: row.time_updated,
    })

    const create = Effect.fn("Goal.create")(function* (input: CreateInput) {
      const content = input.content.trim()
      if (!content) return yield* Effect.fail(new Error("Goal content must not be empty"))
      const id = Identifier.ascending("goal")
      const row = {
        id,
        session_id: input.sessionID,
        content,
        status: "open" as GoalStatus,
        priority: input.priority ?? ("medium" as GoalPriority),
        deadline: input.deadline ?? null,
        done_reason: null,
        time_created: Date.now(),
        time_updated: Date.now(),
      }
      yield* db.insert(GoalTable).values(row).run().pipe(Effect.orDie)
      return rowToInfo(row)
    })

    const update = Effect.fn("Goal.update")(function* (input: UpdateInput) {
      const existing = yield* db
        .select()
        .from(GoalTable)
        .where(and(eq(GoalTable.id, input.id), eq(GoalTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!existing) return undefined

      const nextStatus = input.status ?? existing.status
      if (!isValidTransition(existing.status, nextStatus)) {
        return yield* Effect.fail(new Error(`Invalid status transition: ${existing.status} → ${nextStatus}`))
      }
      const doneReason = (input.done_reason?.trim() || existing.done_reason) ?? undefined
      if (nextStatus === "done" && nextStatus !== existing.status && !doneReason) {
        return yield* Effect.fail(new Error("Marking a goal done requires done_reason"))
      }
      const next: Partial<typeof GoalTable.$inferInsert> = {
        status: nextStatus,
        content: input.content?.trim() || existing.content,
        priority: input.priority ?? existing.priority,
        deadline: input.deadline ?? existing.deadline,
        done_reason: input.done_reason !== undefined ? input.done_reason.trim() || null : existing.done_reason,
        time_updated: Date.now(),
      }
      yield* db
        .update(GoalTable)
        .set(next)
        .where(and(eq(GoalTable.id, input.id), eq(GoalTable.session_id, input.sessionID)))
        .run()
        .pipe(Effect.orDie)
      const updated = yield* db
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      return updated ? rowToInfo(updated) : undefined
    })

    const get = Effect.fn("Goal.get")(function* (input: { sessionID: SessionID; id: string }) {
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(and(eq(GoalTable.id, input.id), eq(GoalTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      return row ? rowToInfo(row) : undefined
    })

    const list = Effect.fn("Goal.list")(function* (input: { sessionID: SessionID; status?: Status }) {
      const rows = yield* db
        .select()
        .from(GoalTable)
        .where(
          and(
            eq(GoalTable.session_id, input.sessionID),
            input.status ? eq(GoalTable.status, input.status) : undefined,
          ),
        )
        .orderBy(asc(GoalTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToInfo)
    })

    return Service.of({ create, update, get, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Database.node] })

export * as Goal from "./goal"
