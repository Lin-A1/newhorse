import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { Identifier } from "@newhorse/core/id/id"
import {
  ScheduledEventAuditTable,
  ScheduledEventTable,
  type ScheduledEventAuditAction,
  type ScheduledEventStatus,
  type ScheduledEventType,
} from "@newhorse/core/scheduler/sql"
import type { WorkspaceV2 } from "@newhorse/core/workspace"
import type { SessionSchema } from "@newhorse/core/session/schema"
import { SchedulerEvent } from "@newhorse/schema/scheduler-event"
import { AbsolutePath } from "@newhorse/core/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Profile } from "@/profile"
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { randomUUID } from "node:crypto"

export const ID = Schema.String.pipe(Schema.brand("Scheduler.ID"))
export type ID = Schema.Schema.Type<typeof ID>

export const Status = Schema.Literals(["pending", "paused", "delivered", "cancelled", "failed"])
export type Status = Schema.Schema.Type<typeof Status>

export const Type = Schema.Literals(["reminder", "check_in", "follow_up"])
export type Type = Schema.Schema.Type<typeof Type>

export const Info = Schema.Struct({
  id: ID,
  workspaceID: Schema.optional(Schema.String),
  profileID: Schema.String,
  sessionID: Schema.optional(Schema.String),
  type: Type,
  title: Schema.String,
  body: Schema.String,
  scheduleAt: Schema.Int,
  timezone: Schema.String,
  status: Status,
  attemptCount: Schema.Int,
  lastError: Schema.optional(Schema.String),
  lastFiredAt: Schema.optional(Schema.Int),
  timeCreated: Schema.Int,
  timeUpdated: Schema.Int,
})
export type Info = Schema.Schema.Type<typeof Info>

export interface CreateInput {
  idempotencyKey?: string
  workspaceID?: WorkspaceV2.ID
  directory?: string
  profileID: string
  sessionID?: SessionSchema.ID
  type?: ScheduledEventType
  title: string
  body: string
  scheduleAt: number
  timezone: string
}

export interface UpdateInput {
  id: ID
  title?: string
  body?: string
  scheduleAt?: number
  timezone?: string
  paused?: boolean
}

export class ProactiveDisabled extends Schema.TaggedErrorClass<ProactiveDisabled>()("Scheduler.ProactiveDisabled", {
  profileID: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, ProactiveDisabled>
  readonly list: (input?: { status?: ScheduledEventStatus[]; profileID?: string }) => Effect.Effect<Info[]>
  readonly update: (input: UpdateInput) => Effect.Effect<Info | undefined>
  readonly cancel: (id: ID) => Effect.Effect<void>
  readonly tick: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Scheduler") {}

const LEASE_MS = 30_000
const CLAIM_LIMIT = 4
const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000
const RETRY_DELAY_MS = 60_000
const POLICY_RECHECK_MS = 15 * 60 * 1000

function localMinute(now: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === "hour")?.value)
  const minute = Number(parts.find((part) => part.type === "minute")?.value)
  return hour * 60 + minute
}

function parseMinute(value: string) {
  const [hour, minute] = value.split(":").map(Number)
  return hour * 60 + minute
}

function isQuiet(now: number, quiet: { start: string; end: string; timezone: string }) {
  const current = localMinute(now, quiet.timezone)
  const start = parseMinute(quiet.start)
  const end = parseMinute(quiet.end)
  if (start === end) return true
  return start < end ? current >= start && current < end : current >= start || current < end
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const profiles = yield* Profile.Service
    const owner = randomUUID()

    const decode = (row: typeof ScheduledEventTable.$inferSelect): Info => ({
      id: ID.make(row.id),
      workspaceID: row.workspace_id ?? undefined,
      profileID: row.profile_id,
      sessionID: row.session_id ?? undefined,
      type: row.type,
      title: row.title,
      body: row.body,
      scheduleAt: row.schedule_at,
      timezone: row.timezone,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error ?? undefined,
      lastFiredAt: row.last_fired_at ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    })

    const audit = Effect.fn("Scheduler.audit")(function* (
      eventID: string,
      action: ScheduledEventAuditAction,
      outcome: string,
      reason?: string,
    ) {
      yield* db
        .insert(ScheduledEventAuditTable)
        .values({
          id: Identifier.ascending("scheduledEventAudit"),
          event_id: eventID,
          action,
          outcome,
          reason: reason ?? null,
          time_created: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
    })

    const workspaceFilter = (workspaceID: WorkspaceV2.ID | undefined) =>
      workspaceID ? eq(ScheduledEventTable.workspace_id, workspaceID) : isNull(ScheduledEventTable.workspace_id)

    const create = Effect.fn("Scheduler.create")(function* (input: CreateInput) {
      const workspaceID = input.workspaceID ?? (yield* InstanceState.workspaceID)
      const directory = input.directory ?? (yield* InstanceState.context).directory
      const profile = yield* profiles.runtime(Profile.ID.make(input.profileID)).pipe(Effect.orDie)
      if ((input.type ?? "reminder") !== "reminder" && (!profile.proactive || profile.proactivePaused)) {
        return yield* new ProactiveDisabled({
          profileID: input.profileID,
          message: "Proactive messages are not enabled for this profile",
        })
      }
      const now = Date.now()
      const idempotencyKey = input.idempotencyKey ?? randomUUID()
      const row = yield* db
        .insert(ScheduledEventTable)
        .values({
          id: Identifier.ascending("scheduledEvent"),
          idempotency_key: idempotencyKey,
          workspace_id: workspaceID ?? null,
          directory,
          profile_id: input.profileID,
          session_id: input.sessionID ?? null,
          type: input.type ?? "reminder",
          title: input.title.trim(),
          body: input.body.trim(),
          schedule_at: input.scheduleAt,
          timezone: input.timezone,
          status: "pending",
          lease_owner: null,
          lease_expires_at: null,
          attempt_count: 0,
          last_error: null,
          last_fired_at: null,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        const winner = yield* db
          .select()
          .from(ScheduledEventTable)
          .where(
            and(
              eq(ScheduledEventTable.idempotency_key, idempotencyKey),
              eq(ScheduledEventTable.profile_id, input.profileID),
              workspaceFilter(workspaceID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (winner) return decode(winner)
        return yield* Effect.die(new Error("Scheduled event insert conflicted without an idempotent winner"))
      }
      yield* audit(row.id, "created", "success")
      return decode(row)
    })

    const list = Effect.fn("Scheduler.list")(function* (input?: {
      status?: ScheduledEventStatus[]
      profileID?: string
    }) {
      const workspaceID = yield* InstanceState.workspaceID
      const conditions = [workspaceFilter(workspaceID)]
      if (input?.status) conditions.push(inArray(ScheduledEventTable.status, input.status))
      if (input?.profileID) conditions.push(eq(ScheduledEventTable.profile_id, input.profileID))
      const rows = yield* db
        .select()
        .from(ScheduledEventTable)
        .where(and(...conditions))
        .orderBy(asc(ScheduledEventTable.schedule_at))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const update = Effect.fn("Scheduler.update")(function* (input: UpdateInput) {
      const workspaceID = yield* InstanceState.workspaceID
      const now = Date.now()
      const row = yield* db
        .update(ScheduledEventTable)
        .set({
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.body !== undefined ? { body: input.body.trim() } : {}),
          ...(input.scheduleAt !== undefined ? { schedule_at: input.scheduleAt } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.paused !== undefined ? { status: input.paused ? "paused" : "pending" } : {}),
          lease_owner: null,
          lease_expires_at: null,
          time_updated: now,
        })
        .where(
          and(
            eq(ScheduledEventTable.id, input.id),
            workspaceFilter(workspaceID),
            notInArray(ScheduledEventTable.status, ["delivered", "cancelled"]),
            or(isNull(ScheduledEventTable.lease_expires_at), lte(ScheduledEventTable.lease_expires_at, now)),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      yield* audit(
        input.id,
        input.paused === true ? "paused" : input.paused === false ? "resumed" : "updated",
        "success",
      )
      return decode(row)
    })

    const cancel = Effect.fn("Scheduler.cancel")(function* (id: ID) {
      const workspaceID = yield* InstanceState.workspaceID
      const now = Date.now()
      const row = yield* db
        .update(ScheduledEventTable)
        .set({ status: "cancelled", lease_owner: null, lease_expires_at: null, time_updated: now })
        .where(
          and(
            eq(ScheduledEventTable.id, id),
            workspaceFilter(workspaceID),
            notInArray(ScheduledEventTable.status, ["delivered", "cancelled"]),
            or(isNull(ScheduledEventTable.lease_expires_at), lte(ScheduledEventTable.lease_expires_at, now)),
          ),
        )
        .returning({ id: ScheduledEventTable.id })
        .get()
        .pipe(Effect.orDie)
      if (row) yield* audit(id, "cancelled", "success")
    })

    const claim = Effect.fn("Scheduler.claim")(function* (now: number) {
      const rows = yield* db
        .update(ScheduledEventTable)
        .set({ lease_owner: owner, lease_expires_at: now + LEASE_MS, time_updated: now })
        .where(
          and(
            eq(ScheduledEventTable.status, "pending"),
            lte(ScheduledEventTable.schedule_at, now),
            or(isNull(ScheduledEventTable.lease_expires_at), lte(ScheduledEventTable.lease_expires_at, now)),
            sql`${ScheduledEventTable.id} IN (
              SELECT ${ScheduledEventTable.id} FROM ${ScheduledEventTable}
              WHERE ${ScheduledEventTable.status} = 'pending'
                AND ${ScheduledEventTable.schedule_at} <= ${now}
                AND (${ScheduledEventTable.lease_expires_at} IS NULL OR ${ScheduledEventTable.lease_expires_at} <= ${now})
              ORDER BY ${ScheduledEventTable.schedule_at}
              LIMIT ${CLAIM_LIMIT}
            )`,
          ),
        )
        .returning()
        .all()
        .pipe(Effect.orDie)
      return rows
    })

    const deliver = Effect.fn("Scheduler.deliver")(function* (
      row: typeof ScheduledEventTable.$inferSelect,
      now: number,
    ) {
      yield* audit(row.id, "claimed", "success")
      const profile = yield* profiles.runtime(Profile.ID.make(row.profile_id)).pipe(Effect.orDie)
      if (row.type !== "reminder" && (!profile.proactive || profile.proactivePaused)) {
        yield* db
          .update(ScheduledEventTable)
          .set({ status: "cancelled", lease_owner: null, lease_expires_at: null, time_updated: now })
          .where(and(eq(ScheduledEventTable.id, row.id), eq(ScheduledEventTable.lease_owner, owner)))
          .run()
          .pipe(Effect.orDie)
        yield* audit(row.id, "cancelled", "policy", "proactive messaging is not subscribed or is paused")
        return false
      }
      if (row.schedule_at < now - MISSED_WINDOW_MS) {
        yield* db
          .update(ScheduledEventTable)
          .set({
            status: "failed",
            last_error: "missed delivery window",
            lease_owner: null,
            lease_expires_at: null,
            time_updated: now,
          })
          .where(and(eq(ScheduledEventTable.id, row.id), eq(ScheduledEventTable.lease_owner, owner)))
          .run()
          .pipe(Effect.orDie)
        yield* audit(row.id, "failed", "skipped", "missed delivery window")
        return false
      }
      if (row.type !== "reminder" && profile.quietHours && isQuiet(now, profile.quietHours)) {
        yield* db
          .update(ScheduledEventTable)
          .set({ schedule_at: now + POLICY_RECHECK_MS, lease_owner: null, lease_expires_at: null, time_updated: now })
          .where(and(eq(ScheduledEventTable.id, row.id), eq(ScheduledEventTable.lease_owner, owner)))
          .run()
          .pipe(Effect.orDie)
        yield* audit(row.id, "deferred", "quiet_hours", profile.quietHours.timezone)
        return false
      }
      if (row.type !== "reminder") {
        const deliveredSince = now - 24 * 60 * 60 * 1000
        const last = yield* db
          .select({
            count: sql<number>`count(*)`,
            latest: sql<number | null>`max(${ScheduledEventTable.last_fired_at})`,
          })
          .from(ScheduledEventTable)
          .where(
            and(
              eq(ScheduledEventTable.profile_id, row.profile_id),
              row.workspace_id
                ? eq(ScheduledEventTable.workspace_id, row.workspace_id)
                : isNull(ScheduledEventTable.workspace_id),
              inArray(ScheduledEventTable.type, ["check_in", "follow_up"]),
              eq(ScheduledEventTable.status, "delivered"),
              gte(ScheduledEventTable.last_fired_at, deliveredSince),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        const minInterval = profile.proactiveFrequency.minIntervalMinutes * 60 * 1000
        if (
          (last?.count ?? 0) >= profile.proactiveFrequency.maxPerDay ||
          (last?.latest && now - last.latest < minInterval)
        ) {
          yield* db
            .update(ScheduledEventTable)
            .set({
              schedule_at: Math.max(now + POLICY_RECHECK_MS, (last?.latest ?? now) + minInterval),
              lease_owner: null,
              lease_expires_at: null,
              time_updated: now,
            })
            .where(and(eq(ScheduledEventTable.id, row.id), eq(ScheduledEventTable.lease_owner, owner)))
            .run()
            .pipe(Effect.orDie)
          yield* audit(row.id, "deferred", "frequency_limit")
          return false
        }
      }
      if (row.schedule_at < now) yield* audit(row.id, "recovered", "success", "delivered after restart or lease expiry")
      return yield* events
        .publish(
          SchedulerEvent.Due,
          {
            id: row.id,
            ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
            profileID: row.profile_id,
            ...(row.session_id ? { sessionID: row.session_id } : {}),
            eventType: row.type,
            title: row.title,
            body: row.body,
            scheduleAt: row.schedule_at,
          },
          {
            location: {
              directory: AbsolutePath.make(row.directory),
              ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
            },
          },
        )
        .pipe(
          Effect.tap(() =>
            db
              .update(ScheduledEventTable)
              .set({
                status: "delivered",
                last_fired_at: now,
                lease_owner: null,
                lease_expires_at: null,
                attempt_count: row.attempt_count + 1,
                last_error: null,
                time_updated: now,
              })
              .where(and(eq(ScheduledEventTable.id, row.id), eq(ScheduledEventTable.lease_owner, owner)))
              .run()
              .pipe(Effect.orDie),
          ),
          Effect.tap(() => audit(row.id, "delivered", "success")),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const message = String(cause)
              yield* db
                .update(ScheduledEventTable)
                .set({
                  schedule_at: now + RETRY_DELAY_MS,
                  lease_owner: null,
                  lease_expires_at: null,
                  attempt_count: row.attempt_count + 1,
                  last_error: message,
                  time_updated: now,
                })
                .where(and(eq(ScheduledEventTable.id, row.id), eq(ScheduledEventTable.lease_owner, owner)))
                .run()
                .pipe(Effect.orDie)
              yield* audit(row.id, "failed", "retry", message)
              return false
            }),
          ),
        )
    })

    const tick = Effect.fn("Scheduler.tick")(function* (now = Date.now()) {
      const rows = yield* claim(now)
      const groups = Map.groupBy(rows, (row) =>
        row.type === "reminder" ? `reminder:${row.id}` : `proactive:${row.profile_id}:${row.workspace_id ?? ""}`,
      )
      const delivered = yield* Effect.forEach(
        groups.values(),
        (group) => Effect.forEach(group, (row) => deliver(row, now), { concurrency: 1 }),
        { concurrency: CLAIM_LIMIT },
      )
      return delivered.flat().filter(Boolean).length
    })

    yield* tick().pipe(
      Effect.catchCause((cause) => Effect.logError("scheduler tick failed", { cause })),
      Effect.repeat(Schedule.spaced(Duration.seconds(15))),
      Effect.forkScoped,
    )

    return Service.of({ create, list, update, cancel, tick })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, EventV2Bridge.node, Profile.node] })

export * as Scheduler from "./index"
