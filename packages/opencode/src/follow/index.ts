import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@newhorse/core/database/database"
import { serviceUse } from "@newhorse/core/effect/service-use"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { FollowTable, type FollowKind, type FollowStatus } from "@newhorse/core/follow/sql"
import { eq, and, desc } from "drizzle-orm"

export type FollowInfo = {
  id: string
  workspaceID: string | null
  directory: string | null
  profileID: string | null
  kind: FollowKind
  topic: string
  checkIntervalMinutes: number
  lastValue: string | null
  lastCheckedAt: number | null
  status: FollowStatus
  timeCreated: number
  timeUpdated: number
}

export interface FollowInterface {
  readonly list: () => Effect.Effect<FollowInfo[]>
  readonly create: (input: {
    kind: FollowKind
    topic: string
    checkIntervalMinutes?: number
    profileID?: string
    directory?: string
  }) => Effect.Effect<FollowInfo>
  readonly remove: (id: string) => Effect.Effect<void>
  readonly updateLastValue: (input: { id: string; value: string | null }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, FollowInterface>()("@newhorse/Follow") {}

export const use = serviceUse(Service)

type Row = typeof FollowTable.$inferSelect

function fromRow(row: Row): FollowInfo {
  return {
    id: row.id,
    workspaceID: row.workspace_id,
    directory: row.directory,
    profileID: row.profile_id,
    kind: row.kind as FollowKind,
    topic: row.topic,
    checkIntervalMinutes: row.check_interval_minutes,
    lastValue: row.last_value,
    lastCheckedAt: row.last_checked_at,
    status: row.status as FollowStatus,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

export const computeValueFor = (follow: FollowInfo, now = Date.now()): string | null => {
  // deadline: topic is a date the user wants tracked ("2026-09-01", ISO). Returns
  // a normalized "time left" string; null if the topic isn't a parseable date.
  if (follow.kind === "deadline") {
    const target = Date.parse(follow.topic)
    if (!Number.isFinite(target)) return null
    const remaining = target - now
    if (remaining <= 0) return "expired"
    const days = Math.ceil(remaining / 86_400_000)
    return days <= 1 ? "due within 24h" : `${days} days left`
  }
  // topic / release / price: the check action is scheduled (scheduler runs a web
  // search / fetch via the LLM tool executor) and writes the result back through
  // updateLastValue. Auto-detection of topic changes without a network search is
  // intentionally left to the scheduler; here we only return the stored lastValue
  // as the current signal so change detection is uniform.
  return follow.lastValue
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = () =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(FollowTable)
          .orderBy(desc(FollowTable.time_updated))
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromRow)
      })

    const create = Effect.fn(function* (input: {
      kind: FollowKind
      topic: string
      checkIntervalMinutes?: number
      profileID?: string
      directory?: string
    }) {
      const now = Date.now()
      const id = `${input.kind.slice(0, 3)}_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const row = {
        id,
        workspace_id: null,
        directory: input.directory ?? null,
        scope: "personal",
        profile_id: input.profileID ?? null,
        kind: input.kind,
        topic: input.topic.trim(),
        check_interval_minutes: input.checkIntervalMinutes ?? 60,
        last_value: null,
        last_checked_at: null,
        status: "active",
        time_created: now,
        time_updated: now,
      } satisfies typeof FollowTable.$inferInsert
      yield* db.insert(FollowTable).values(row).pipe(Effect.orDie)
      return fromRow(row)
    })

    const remove = Effect.fn(function* (id: string) {
      yield* db.delete(FollowTable).where(eq(FollowTable.id, id)).pipe(Effect.orDie)
    })

    const updateLastValue = Effect.fn(function* (input: { id: string; value: string | null }) {
      const now = Date.now()
      yield* db
        .update(FollowTable)
        .set({ last_value: input.value, last_checked_at: now, time_updated: now })
        .where(eq(FollowTable.id, input.id))
        .pipe(Effect.orDie)
      return true
    })

    return Service.of({ list, create, remove, updateLastValue })
  }),
)

export * as Follow from "./index"

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node],
})
