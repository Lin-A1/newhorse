import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { Identifier } from "@newhorse/core/id/id"
import {
  ScheduledEventAuditTable,
  ScheduledEventDeliveryTable,
  ScheduledEventTable,
  type ScheduledEventAuditAction,
  type ScheduledEventMisfirePolicy,
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
import { Follow, node as followNode, computeValueFor } from "@/follow"
import { TrustPolicy } from "@/trust-policy"
import { WorkspacePolicy } from "@/control-plane/workspace-policy"
import { normalizeRule, nextOccurrence, occurrencesAfter } from "./recurrence"
import { MemoryTable } from "@newhorse/core/memory/sql"
import { DailySummaryTable } from "@newhorse/core/daily-summary/sql"
import { overviewFromContent } from "@/daily-summary/readers"
import { SessionTable } from "@newhorse/core/session/sql"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Ref, Schedule, Schema } from "effect"
import { randomUUID } from "node:crypto"

export const ID = Schema.String.pipe(Schema.brand("Scheduler.ID"))
export type ID = Schema.Schema.Type<typeof ID>

export const Status = Schema.Literals(["pending", "paused", "dispatching", "delivered", "cancelled", "failed"])
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
  recurrenceRule: Schema.optional(Schema.String),
  misfirePolicy: Schema.Literals(["catch_up_once", "skip"]),
  status: Status,
  attemptCount: Schema.Int,
  lastError: Schema.optional(Schema.String),
  lastFiredAt: Schema.optional(Schema.Int),
  timeCreated: Schema.Int,
  timeUpdated: Schema.Int,
})
export type Info = Schema.Schema.Type<typeof Info>

export const AuditInfo = Schema.Struct({
  id: Schema.String,
  eventID: ID,
  action: Schema.Literals([
    "created",
    "updated",
    "paused",
    "resumed",
    "cancelled",
    "claimed",
    "deferred",
    "staged",
    "skipped",
    "delivered",
    "failed",
    "recovered",
    "retry_scheduled",
  ]),
  outcome: Schema.String,
  reason: Schema.optional(Schema.String),
  occurrenceAt: Schema.optional(Schema.Int),
  deliveryKey: Schema.optional(Schema.String),
  timeCreated: Schema.Int,
})
export type AuditInfo = Schema.Schema.Type<typeof AuditInfo>

export const AuditPage = Schema.Struct({
  items: Schema.Array(AuditInfo),
  nextCursor: Schema.optional(Schema.String),
})
export type AuditPage = Schema.Schema.Type<typeof AuditPage>

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
  recurrenceRule?: string
  misfirePolicy?: ScheduledEventMisfirePolicy
}

export interface UpdateInput {
  id: ID
  title?: string
  body?: string
  scheduleAt?: number
  timezone?: string
  recurrenceRule?: string | null
  misfirePolicy?: ScheduledEventMisfirePolicy
  paused?: boolean
}

export class ProactiveDisabled extends Schema.TaggedErrorClass<ProactiveDisabled>()("Scheduler.ProactiveDisabled", {
  profileID: Schema.String,
  message: Schema.String,
}) {}

export class PolicyRejected extends Schema.TaggedErrorClass<PolicyRejected>()("Scheduler.PolicyRejected", {
  message: Schema.String,
}) {}

export class InvalidSchedule extends Schema.TaggedErrorClass<InvalidSchedule>()("Scheduler.InvalidSchedule", {
  message: Schema.String,
}) {}

export interface QueryInput {
  status?: ScheduledEventStatus[]
  profileID?: string
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, ProactiveDisabled | InvalidSchedule | PolicyRejected>
  readonly list: (input?: QueryInput) => Effect.Effect<Info[]>
  readonly count: (input?: QueryInput) => Effect.Effect<number>
  readonly update: (input: UpdateInput) => Effect.Effect<Info | undefined, InvalidSchedule>
  readonly cancel: (id: ID) => Effect.Effect<boolean>
  readonly audit: (id: ID, input?: { limit?: number; cursor?: string }) => Effect.Effect<AuditPage | undefined>
  readonly tick: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Scheduler") {}

const LEASE_MS = 30_000
const CLAIM_LIMIT = 4
const MAX_DELIVERY_ATTEMPTS = 5
const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000
const RECURRENCE_MISFIRE_GRACE_MS = 60_000
const RETRY_BASE_MS = 60_000
const RETRY_CAP_MS = 60 * 60 * 1000
const POLICY_RECHECK_MS = 15 * 60 * 1000
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
// Auto check-in: never interrupt a profile whose most recent session was
// updated within this window (the user is mid-conversation).
const AUTO_CHECK_IN_IDLE_MS = 30 * 60 * 1000

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

function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

/** Local date key YYYY-MM-DD (same convention as the daily-summary module). */
function localDateKey(ts: number) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function normalizeSchedule(input: { scheduleAt: number; timezone: string; recurrenceRule?: string }) {
  if (!Number.isSafeInteger(input.scheduleAt)) return new InvalidSchedule({ message: "scheduleAt must be an integer" })
  if (!validTimezone(input.timezone)) return new InvalidSchedule({ message: "timezone must be a valid IANA timezone" })
  if (!input.recurrenceRule) return { recurrenceRule: undefined }
  const recurrenceRule = normalizeRule(input.recurrenceRule)
  if (!recurrenceRule) return new InvalidSchedule({ message: "recurrenceRule supports only daily or weekly intervals" })
  return { recurrenceRule }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const profiles = yield* Profile.Service
    const follow = yield* Follow.Service
    const trustPolicy = yield* TrustPolicy.Service
    const owner = randomUUID()

    type SeriesRow = typeof ScheduledEventTable.$inferSelect
    type DeliveryRow = typeof ScheduledEventDeliveryTable.$inferSelect
    type OccurrencePlan = {
      occurrenceAt?: number
      nextScheduleAt?: number
      skipped: boolean
    }

    const decode = (row: SeriesRow): Info => ({
      id: ID.make(row.id),
      workspaceID: row.workspace_id ?? undefined,
      profileID: row.profile_id,
      sessionID: row.session_id ?? undefined,
      type: row.type,
      title: row.title,
      body: row.body,
      scheduleAt: row.schedule_at,
      timezone: row.timezone,
      recurrenceRule: row.recurrence_rule ?? undefined,
      misfirePolicy: row.misfire_policy,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error ?? undefined,
      lastFiredAt: row.last_fired_at ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    })

    const decodeAudit = (row: typeof ScheduledEventAuditTable.$inferSelect): AuditInfo => ({
      id: row.id,
      eventID: ID.make(row.event_id),
      action: row.action,
      outcome: row.outcome,
      reason: row.reason ?? undefined,
      occurrenceAt: row.occurrence_at ?? undefined,
      deliveryKey: row.delivery_key ?? undefined,
      timeCreated: row.time_created,
    })

    const auditValues = (input: {
      eventID: string
      action: ScheduledEventAuditAction
      outcome: string
      now: number
      reason?: string
      occurrenceAt?: number
      deliveryKey?: string
    }) => ({
      id: Identifier.ascending("scheduledEventAudit"),
      event_id: input.eventID,
      action: input.action,
      outcome: input.outcome,
      reason: input.reason ?? null,
      occurrence_at: input.occurrenceAt ?? null,
      delivery_key: input.deliveryKey ?? null,
      time_created: input.now,
    })

    const scopeFilter = (workspaceID: WorkspaceV2.ID | undefined, directory: string) =>
      workspaceID
        ? eq(ScheduledEventTable.workspace_id, workspaceID)
        : and(isNull(ScheduledEventTable.workspace_id), eq(ScheduledEventTable.directory, directory))

    // The current unique index coalesces a missing workspace to an empty string. Namespace
    // workspace-less keys by directory so identical user keys remain isolated without a schema change.
    const storedIdempotencyKey = (key: string, workspaceID: WorkspaceV2.ID | undefined, directory: string) =>
      workspaceID ? key : JSON.stringify([directory, key])

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
      const policy = yield* WorkspacePolicy.current
      const destination: TrustPolicy.ContentScope = profile.kind === "companion" ? "personal" : policy.contentScope
      const flow = yield* trustPolicy.decide({
        action: "reminder.create",
        source: policy.contentScope,
        destination,
        actor: input.profileID ?? "reminder",
      })
      if (flow.decision === "deny") {
        return yield* new PolicyRejected({ message: "Reminder creation is not permitted by the content-flow policy" })
      }
      const now = Date.now()
      const schedule = normalizeSchedule(input)
      if (schedule instanceof InvalidSchedule) return yield* schedule
      const idempotencyKey = storedIdempotencyKey(input.idempotencyKey ?? randomUUID(), workspaceID, directory)
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const inserted = yield* tx
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
                  eligible_at: input.scheduleAt,
                  timezone: input.timezone,
                  recurrence_rule: schedule.recurrenceRule ?? null,
                  recurrence_anchor_at: schedule.recurrenceRule ? input.scheduleAt : null,
                  misfire_policy: input.misfirePolicy ?? "catch_up_once",
                  status: "pending",
                  lease_owner: null,
                  lease_token: 0,
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
              if (!inserted) {
                const winner = yield* tx
                  .select()
                  .from(ScheduledEventTable)
                  .where(
                    and(
                      eq(ScheduledEventTable.idempotency_key, idempotencyKey),
                      eq(ScheduledEventTable.profile_id, input.profileID),
                      scopeFilter(workspaceID, directory),
                    ),
                  )
                  .get()
                if (winner) return winner
                return yield* Effect.die(new Error("Scheduled event insert conflicted without an idempotent winner"))
              }
              yield* tx
                .insert(ScheduledEventAuditTable)
                .values(auditValues({ eventID: inserted.id, action: "created", outcome: "success", now }))
                .run()
              return inserted
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return decode(row)
    })

    const conditions = (workspaceID: WorkspaceV2.ID | undefined, directory: string, input?: QueryInput) => {
      // Reminders may be created in the project workspace OR in the companion's
      // personal scope (null workspace) within the same directory. List both so
      // the panel shows companion-created reminders no matter which session's
      // settings you open.
      const scope =
        workspaceID !== undefined
          ? or(
              eq(ScheduledEventTable.workspace_id, workspaceID),
              and(isNull(ScheduledEventTable.workspace_id), eq(ScheduledEventTable.directory, directory)),
            )
          : and(isNull(ScheduledEventTable.workspace_id), eq(ScheduledEventTable.directory, directory))
      const result = [scope]
      if (input?.status) result.push(inArray(ScheduledEventTable.status, input.status))
      if (input?.profileID) result.push(eq(ScheduledEventTable.profile_id, input.profileID))
      return result
    }

    const list = Effect.fn("Scheduler.list")(function* (input?: QueryInput) {
      const workspaceID = yield* InstanceState.workspaceID
      const directory = (yield* InstanceState.context).directory
      const rows = yield* db
        .select()
        .from(ScheduledEventTable)
        .where(and(...conditions(workspaceID, directory, input)))
        .orderBy(asc(ScheduledEventTable.schedule_at))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const count = Effect.fn("Scheduler.count")(function* (input?: QueryInput) {
      const workspaceID = yield* InstanceState.workspaceID
      const directory = (yield* InstanceState.context).directory
      const row = yield* db
        .select({ count: sql<number>`count(*)` })
        .from(ScheduledEventTable)
        .where(and(...conditions(workspaceID, directory, input)))
        .get()
        .pipe(Effect.orDie)
      return row?.count ?? 0
    })

    const update = Effect.fn("Scheduler.update")(function* (input: UpdateInput) {
      const workspaceID = yield* InstanceState.workspaceID
      const directory = (yield* InstanceState.context).directory
      const now = Date.now()
      const current = yield* db
        .select()
        .from(ScheduledEventTable)
        .where(and(eq(ScheduledEventTable.id, input.id), scopeFilter(workspaceID, directory)))
        .get()
        .pipe(Effect.orDie)
      if (!current) return undefined
      const schedule = normalizeSchedule({
        scheduleAt: input.scheduleAt ?? current.schedule_at,
        timezone: input.timezone ?? current.timezone,
        recurrenceRule: input.recurrenceRule === null ? undefined : (input.recurrenceRule ?? current.recurrence_rule ?? undefined),
      })
      if (schedule instanceof InvalidSchedule) return yield* schedule
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
                .update(ScheduledEventTable)
                .set({
                  ...(input.title !== undefined ? { title: input.title.trim() } : {}),
                  ...(input.body !== undefined ? { body: input.body.trim() } : {}),
                  ...(input.scheduleAt !== undefined
                    ? { schedule_at: input.scheduleAt, eligible_at: input.scheduleAt, last_error: null }
                    : {}),
                  ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
                  ...(input.recurrenceRule !== undefined
                    ? {
                        recurrence_rule: schedule.recurrenceRule ?? null,
                        recurrence_anchor_at: schedule.recurrenceRule ? (input.scheduleAt ?? current.schedule_at) : null,
                        misfire_policy: input.misfirePolicy ?? current.misfire_policy,
                      }
                    : input.misfirePolicy !== undefined
                      ? { misfire_policy: input.misfirePolicy }
                      : {}),
                  ...(input.paused !== undefined ? { status: input.paused ? "paused" : "pending" } : {}),
                  lease_owner: null,
                  lease_expires_at: null,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(ScheduledEventTable.id, input.id),
                    scopeFilter(workspaceID, directory),
                    notInArray(ScheduledEventTable.status, ["dispatching", "delivered", "cancelled", "failed"]),
                    or(isNull(ScheduledEventTable.lease_expires_at), lte(ScheduledEventTable.lease_expires_at, now)),
                  ),
                )
                .returning()
                .get()
              if (!updated) return undefined
              yield* tx
                .insert(ScheduledEventAuditTable)
                .values(
                  auditValues({
                    eventID: input.id,
                    action: input.paused === true ? "paused" : input.paused === false ? "resumed" : "updated",
                    outcome: "success",
                    now,
                  }),
                )
                .run()
              return updated
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const cancel = Effect.fn("Scheduler.cancel")(function* (id: ID) {
      const workspaceID = yield* InstanceState.workspaceID
      const directory = (yield* InstanceState.context).directory
      const now = Date.now()
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const active = yield* tx
                .select({ id: ScheduledEventDeliveryTable.id })
                .from(ScheduledEventDeliveryTable)
                .where(
                  and(
                    eq(ScheduledEventDeliveryTable.event_id, id),
                    inArray(ScheduledEventDeliveryTable.status, ["pending", "retry"]),
                    sql`${ScheduledEventDeliveryTable.lease_owner} IS NOT NULL`,
                    gt(ScheduledEventDeliveryTable.lease_expires_at, now),
                  ),
                )
                .get()
              if (active) return false
              const row = yield* tx
                .update(ScheduledEventTable)
                .set({ status: "cancelled", lease_owner: null, lease_expires_at: null, time_updated: now })
                .where(
                  and(
                    eq(ScheduledEventTable.id, id),
                    scopeFilter(workspaceID, directory),
                    notInArray(ScheduledEventTable.status, ["delivered", "cancelled", "failed"]),
                  ),
                )
                .returning({ id: ScheduledEventTable.id })
                .get()
              if (!row) return false
              yield* tx
                .update(ScheduledEventDeliveryTable)
                .set({
                  status: "cancelled",
                  lease_owner: null,
                  lease_expires_at: null,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(ScheduledEventDeliveryTable.event_id, id),
                    inArray(ScheduledEventDeliveryTable.status, ["pending", "retry"]),
                  ),
                )
                .run()
              yield* tx
                .insert(ScheduledEventAuditTable)
                .values(auditValues({ eventID: id, action: "cancelled", outcome: "success", now }))
                .run()
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const audit = Effect.fn("Scheduler.audit")(function* (
      id: ID,
      input?: { limit?: number; cursor?: string },
    ) {
      const workspaceID = yield* InstanceState.workspaceID
      const directory = (yield* InstanceState.context).directory
      const owned = yield* db
        .select({ id: ScheduledEventTable.id })
        .from(ScheduledEventTable)
        .where(and(eq(ScheduledEventTable.id, id), scopeFilter(workspaceID, directory)))
        .get()
        .pipe(Effect.orDie)
      if (!owned) return undefined
      const limit = Math.min(Math.max(input?.limit ?? 50, 1), 100)
      const rows = yield* db
        .select()
        .from(ScheduledEventAuditTable)
        .where(
          and(
            eq(ScheduledEventAuditTable.event_id, id),
            ...(input?.cursor ? [lt(ScheduledEventAuditTable.id, input.cursor)] : []),
          ),
        )
        .orderBy(desc(ScheduledEventAuditTable.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const page = rows.slice(0, limit)
      return { items: page.map(decodeAudit), nextCursor: rows.length > limit ? page.at(-1)?.id : undefined }
    })

    const claimSeries = Effect.fn("Scheduler.claimSeries")(function* (now: number) {
      return yield* db
        .update(ScheduledEventTable)
        .set({
          lease_owner: owner,
          lease_token: sql`${ScheduledEventTable.lease_token} + 1`,
          lease_expires_at: now + LEASE_MS,
          time_updated: now,
        })
        .where(
          and(
            eq(ScheduledEventTable.status, "pending"),
            lte(ScheduledEventTable.eligible_at, now),
            or(isNull(ScheduledEventTable.lease_expires_at), lte(ScheduledEventTable.lease_expires_at, now)),
            sql`${ScheduledEventTable.id} IN (
              SELECT ${ScheduledEventTable.id} FROM ${ScheduledEventTable}
              WHERE ${ScheduledEventTable.status} = 'pending'
                AND ${ScheduledEventTable.eligible_at} <= ${now}
                AND (${ScheduledEventTable.lease_expires_at} IS NULL OR ${ScheduledEventTable.lease_expires_at} <= ${now})
              ORDER BY ${ScheduledEventTable.eligible_at}, ${ScheduledEventTable.id}
              LIMIT ${CLAIM_LIMIT}
            )`,
          ),
        )
        .returning()
        .all()
        .pipe(Effect.orDie)
    })

    const claimCondition = (row: SeriesRow) =>
      and(
        eq(ScheduledEventTable.id, row.id),
        eq(ScheduledEventTable.status, "pending"),
        eq(ScheduledEventTable.lease_owner, owner),
        eq(ScheduledEventTable.lease_token, row.lease_token),
      )

    const finishClaim = Effect.fn("Scheduler.finishClaim")(function* (
      row: SeriesRow,
      now: number,
      input:
        | { status: "cancelled" | "failed"; action: "cancelled" | "skipped"; outcome: string; reason: string }
        | { status: "deferred"; eligibleAt: number; outcome: string; reason?: string },
    ) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
                .update(ScheduledEventTable)
                .set(
                  input.status === "deferred"
                    ? {
                        eligible_at: input.eligibleAt,
                        lease_owner: null,
                        lease_expires_at: null,
                        time_updated: now,
                      }
                    : {
                        status: input.status,
                        last_error: input.status === "failed" ? input.reason : null,
                        lease_owner: null,
                        lease_expires_at: null,
                        time_updated: now,
                      },
                )
                .where(claimCondition(row))
                .returning({ id: ScheduledEventTable.id })
                .get()
              if (!updated) return false
              yield* tx
                .insert(ScheduledEventAuditTable)
                .values([
                  auditValues({
                    eventID: row.id,
                    action: "claimed",
                    outcome: "success",
                    occurrenceAt: row.schedule_at,
                    now,
                  }),
                  auditValues({
                    eventID: row.id,
                    action: input.status === "deferred" ? "deferred" : input.action,
                    outcome: input.outcome,
                    reason: input.reason,
                    occurrenceAt: row.schedule_at,
                    now,
                  }),
                ])
                .run()
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const occurrencePlan = (row: SeriesRow, now: number): OccurrencePlan | undefined => {
      if (!row.recurrence_rule) return { occurrenceAt: row.schedule_at, skipped: false }
      if (now - row.schedule_at <= RECURRENCE_MISFIRE_GRACE_MS) {
        const nextScheduleAt = nextOccurrence({
          occurrenceAt: row.schedule_at,
          recurrenceRule: row.recurrence_rule,
          timezone: row.timezone,
        })
        return nextScheduleAt === undefined
          ? undefined
          : { occurrenceAt: row.schedule_at, nextScheduleAt, skipped: false }
      }
      const result = occurrencesAfter({
        scheduleAt: row.schedule_at,
        recurrenceRule: row.recurrence_rule,
        timezone: row.timezone,
        now,
        misfirePolicy: row.misfire_policy,
      })
      if (!result) return
      return {
        occurrenceAt: result.occurrenceAt,
        nextScheduleAt: result.nextScheduleAt,
        skipped: result.occurrenceAt === undefined,
      }
    }

    const stage = Effect.fn("Scheduler.stage")(function* (row: SeriesRow, now: number, plan: OccurrencePlan) {
      const occurrenceAt = plan.occurrenceAt
      const deliveryKey = occurrenceAt === undefined ? undefined : `${row.id}:${occurrenceAt}`
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select({ id: ScheduledEventTable.id })
                .from(ScheduledEventTable)
                .where(claimCondition(row))
                .get()
              if (!current) return false

              if (occurrenceAt !== undefined && deliveryKey !== undefined) {
                const delivery = yield* tx
                  .insert(ScheduledEventDeliveryTable)
                  .values({
                    id: Identifier.ascending("scheduledEventDelivery"),
                    event_id: row.id,
                    occurrence_at: occurrenceAt,
                    delivery_key: deliveryKey,
                    workspace_id: row.workspace_id,
                    directory: row.directory,
                    profile_id: row.profile_id,
                    session_id: row.session_id,
                    event_type: row.type,
                    title: row.title,
                    body: row.body,
                    status: "pending",
                    available_at: now,
                    attempt_count: 0,
                    max_attempts: MAX_DELIVERY_ATTEMPTS,
                    lease_owner: null,
                    lease_token: 0,
                    lease_expires_at: null,
                    last_error: null,
                    time_delivered: null,
                    time_created: now,
                    time_updated: now,
                  })
                  .onConflictDoNothing()
                  .returning({ id: ScheduledEventDeliveryTable.id })
                  .get()
                if (!delivery) return false
              }

              const recurring = plan.nextScheduleAt !== undefined
              const updated = yield* tx
                .update(ScheduledEventTable)
                .set(
                  recurring
                    ? {
                        schedule_at: plan.nextScheduleAt,
                        eligible_at: plan.nextScheduleAt,
                        status: "pending",
                        lease_owner: null,
                        lease_expires_at: null,
                        last_error: null,
                        time_updated: now,
                      }
                    : {
                        status: "dispatching",
                        lease_owner: null,
                        lease_expires_at: null,
                        time_updated: now,
                      },
                )
                .where(claimCondition(row))
                .returning({ id: ScheduledEventTable.id })
                .get()
              if (!updated) return false
              yield* tx
                .insert(ScheduledEventAuditTable)
                .values([
                  auditValues({
                    eventID: row.id,
                    action: "claimed",
                    outcome: "success",
                    occurrenceAt: row.schedule_at,
                    now,
                  }),
                  auditValues({
                    eventID: row.id,
                    action: plan.skipped ? "skipped" : "staged",
                    outcome: plan.skipped ? "misfire_policy" : "success",
                    occurrenceAt: occurrenceAt ?? row.schedule_at,
                    deliveryKey,
                    now,
                  }),
                ])
                .run()
              return occurrenceAt !== undefined
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const evaluateAndStage = Effect.fn("Scheduler.evaluateAndStage")(function* (
      row: SeriesRow,
      now: number,
      profile: Profile.Runtime,
    ) {
      if (row.type !== "reminder" && (!profile.proactive || profile.proactivePaused)) {
        yield* finishClaim(row, now, {
          status: "cancelled",
          action: "cancelled",
          outcome: "policy",
          reason: "proactive messaging is not subscribed or is paused",
        })
        return false
      }
      if (!row.recurrence_rule && row.schedule_at < now - MISSED_WINDOW_MS) {
        yield* finishClaim(row, now, {
          status: "failed",
          action: "skipped",
          outcome: "missed_window",
          reason: "missed delivery window",
        })
        return false
      }
      if (row.type !== "reminder" && profile.quietHours && isQuiet(now, profile.quietHours)) {
        yield* finishClaim(row, now, {
          status: "deferred",
          eligibleAt: now + POLICY_RECHECK_MS,
          outcome: "quiet_hours",
          reason: profile.quietHours.timezone,
        })
        return false
      }
      if (row.type !== "reminder") {
        const deliveredSince = now - 24 * 60 * 60 * 1000
        const effectiveDeliveryAt = sql<number>`coalesce(${ScheduledEventDeliveryTable.time_delivered}, ${ScheduledEventDeliveryTable.occurrence_at})`
        const last = yield* db
          .select({
            count: sql<number>`count(*)`,
            latest: sql<number | null>`max(${effectiveDeliveryAt})`,
          })
          .from(ScheduledEventDeliveryTable)
          .where(
            and(
              eq(ScheduledEventDeliveryTable.profile_id, row.profile_id),
              row.workspace_id
                ? eq(ScheduledEventDeliveryTable.workspace_id, row.workspace_id)
                : and(
                    isNull(ScheduledEventDeliveryTable.workspace_id),
                    eq(ScheduledEventDeliveryTable.directory, row.directory),
                  ),
              inArray(ScheduledEventDeliveryTable.event_type, ["check_in", "follow_up"]),
              inArray(ScheduledEventDeliveryTable.status, ["pending", "retry", "delivered"]),
              gte(effectiveDeliveryAt, deliveredSince),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        const minInterval = profile.proactiveFrequency.minIntervalMinutes * 60 * 1000
        if (
          (last?.count ?? 0) >= profile.proactiveFrequency.maxPerDay ||
          (last?.latest !== null && last?.latest !== undefined && now - last.latest < minInterval)
        ) {
          yield* finishClaim(row, now, {
            status: "deferred",
            eligibleAt: Math.max(now + POLICY_RECHECK_MS, (last?.latest ?? now) + minInterval),
            outcome: "frequency_limit",
          })
          return false
        }
      }
      const plan = occurrencePlan(row, now)
      if (!plan) {
        yield* finishClaim(row, now, {
          status: "failed",
          action: "skipped",
          outcome: "invalid_recurrence",
          reason: "recurrence rule or timezone is invalid",
        })
        return false
      }
      return yield* stage(row, now, plan)
    })

    const recoverExpiredDeliveries = Effect.fn("Scheduler.recoverExpiredDeliveries")(function* (now: number) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select()
                .from(ScheduledEventDeliveryTable)
                .where(
                  and(
                    inArray(ScheduledEventDeliveryTable.status, ["pending", "retry"]),
                    sql`${ScheduledEventDeliveryTable.lease_owner} IS NOT NULL`,
                    lte(ScheduledEventDeliveryTable.lease_expires_at, now),
                    lt(ScheduledEventDeliveryTable.attempt_count, ScheduledEventDeliveryTable.max_attempts),
                  ),
                )
                .orderBy(asc(ScheduledEventDeliveryTable.lease_expires_at))
                .limit(CLAIM_LIMIT)
                .all()
              for (const row of rows) {
                const delay = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, row.attempt_count - 1), RETRY_CAP_MS)
                const reason = "delivery interrupted before acknowledgement"
                const updated = yield* tx
                  .update(ScheduledEventDeliveryTable)
                  .set({
                    status: "retry",
                    available_at: now + delay,
                    lease_owner: null,
                    lease_expires_at: null,
                    last_error: reason,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(ScheduledEventDeliveryTable.id, row.id),
                      eq(ScheduledEventDeliveryTable.lease_token, row.lease_token),
                      eq(ScheduledEventDeliveryTable.lease_owner, row.lease_owner!),
                    ),
                  )
                  .returning({ id: ScheduledEventDeliveryTable.id })
                  .get()
                if (!updated) continue
                yield* tx
                  .update(ScheduledEventTable)
                  .set({ attempt_count: row.attempt_count, last_error: reason, time_updated: now })
                  .where(eq(ScheduledEventTable.id, row.event_id))
                  .run()
                yield* tx
                  .insert(ScheduledEventAuditTable)
                  .values(
                    auditValues({
                      eventID: row.event_id,
                      action: "retry_scheduled",
                      outcome: "lease_expired",
                      reason,
                      occurrenceAt: row.occurrence_at,
                      deliveryKey: row.delivery_key,
                      now,
                    }),
                  )
                  .run()
              }
              return rows.length
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const failExhaustedDeliveries = Effect.fn("Scheduler.failExhaustedDeliveries")(function* (now: number) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select()
                .from(ScheduledEventDeliveryTable)
                .where(
                  and(
                    inArray(ScheduledEventDeliveryTable.status, ["pending", "retry"]),
                    lte(ScheduledEventDeliveryTable.lease_expires_at, now),
                    sql`${ScheduledEventDeliveryTable.attempt_count} >= ${ScheduledEventDeliveryTable.max_attempts}`,
                  ),
                )
                .limit(CLAIM_LIMIT)
                .all()
              if (rows.length === 0) return 0
              for (const row of rows) {
                const series = yield* tx
                  .select({ recurrenceRule: ScheduledEventTable.recurrence_rule })
                  .from(ScheduledEventTable)
                  .where(eq(ScheduledEventTable.id, row.event_id))
                  .get()
                yield* tx
                  .update(ScheduledEventDeliveryTable)
                  .set({
                    status: "failed",
                    lease_owner: null,
                    lease_expires_at: null,
                    last_error: "delivery attempts exhausted",
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(ScheduledEventDeliveryTable.id, row.id),
                      eq(ScheduledEventDeliveryTable.lease_token, row.lease_token),
                    ),
                  )
                  .run()
                yield* tx
                  .update(ScheduledEventTable)
                  .set({
                    ...(!series?.recurrenceRule ? { status: "failed" as const } : {}),
                    attempt_count: row.attempt_count,
                    last_error: "delivery attempts exhausted",
                    time_updated: now,
                  })
                  .where(eq(ScheduledEventTable.id, row.event_id))
                  .run()
                yield* tx
                  .insert(ScheduledEventAuditTable)
                  .values(
                    auditValues({
                      eventID: row.event_id,
                      action: "failed",
                      outcome: "attempts_exhausted",
                      reason: "delivery attempts exhausted",
                      occurrenceAt: row.occurrence_at,
                      deliveryKey: row.delivery_key,
                      now,
                    }),
                  )
                  .run()
              }
              return rows.length
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const claimDeliveries = Effect.fn("Scheduler.claimDeliveries")(function* (now: number) {
      return yield* db
        .update(ScheduledEventDeliveryTable)
        .set({
          lease_owner: owner,
          lease_token: sql`${ScheduledEventDeliveryTable.lease_token} + 1`,
          lease_expires_at: now + LEASE_MS,
          attempt_count: sql`${ScheduledEventDeliveryTable.attempt_count} + 1`,
          time_updated: now,
        })
        .where(
          and(
            inArray(ScheduledEventDeliveryTable.status, ["pending", "retry"]),
            lt(ScheduledEventDeliveryTable.attempt_count, ScheduledEventDeliveryTable.max_attempts),
            lte(ScheduledEventDeliveryTable.available_at, now),
            or(
              isNull(ScheduledEventDeliveryTable.lease_expires_at),
              lte(ScheduledEventDeliveryTable.lease_expires_at, now),
            ),
            sql`${ScheduledEventDeliveryTable.id} IN (
              SELECT ${ScheduledEventDeliveryTable.id} FROM ${ScheduledEventDeliveryTable}
              WHERE ${ScheduledEventDeliveryTable.status} IN ('pending', 'retry')
                AND ${ScheduledEventDeliveryTable.attempt_count} < ${ScheduledEventDeliveryTable.max_attempts}
                AND ${ScheduledEventDeliveryTable.available_at} <= ${now}
                AND (${ScheduledEventDeliveryTable.lease_expires_at} IS NULL OR ${ScheduledEventDeliveryTable.lease_expires_at} <= ${now})
              ORDER BY ${ScheduledEventDeliveryTable.available_at}, ${ScheduledEventDeliveryTable.id}
              LIMIT ${CLAIM_LIMIT}
            )`,
          ),
        )
        .returning()
        .all()
        .pipe(Effect.orDie)
    })

    const deliveryClaimCondition = (row: DeliveryRow) =>
      and(
        eq(ScheduledEventDeliveryTable.id, row.id),
        inArray(ScheduledEventDeliveryTable.status, ["pending", "retry"]),
        eq(ScheduledEventDeliveryTable.lease_owner, owner),
        eq(ScheduledEventDeliveryTable.lease_token, row.lease_token),
      )

    const deliverySucceeded = Effect.fn("Scheduler.deliverySucceeded")(function* (row: DeliveryRow, now: number) {
      const attempt = row.attempt_count
      return yield* Effect.uninterruptible(
        db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const delivery = yield* tx
                  .update(ScheduledEventDeliveryTable)
                  .set({
                    status: "delivered",
                    attempt_count: attempt,
                    lease_owner: null,
                    lease_expires_at: null,
                    last_error: null,
                    time_delivered: now,
                    time_updated: now,
                  })
                  .where(deliveryClaimCondition(row))
                  .returning({ id: ScheduledEventDeliveryTable.id })
                  .get()
                if (!delivery) return false
                const series = yield* tx
                  .select({ recurrenceRule: ScheduledEventTable.recurrence_rule })
                  .from(ScheduledEventTable)
                  .where(eq(ScheduledEventTable.id, row.event_id))
                  .get()
                yield* tx
                  .update(ScheduledEventTable)
                  .set({
                    ...(series?.recurrenceRule ? {} : { status: "delivered" as const }),
                    attempt_count: attempt,
                    last_error: null,
                    last_fired_at: now,
                    time_updated: now,
                  })
                  .where(eq(ScheduledEventTable.id, row.event_id))
                  .run()
                yield* tx
                  .insert(ScheduledEventAuditTable)
                  .values(
                    auditValues({
                      eventID: row.event_id,
                      action: "delivered",
                      outcome: "success",
                      occurrenceAt: row.occurrence_at,
                      deliveryKey: row.delivery_key,
                      now,
                    }),
                  )
                  .run()
                return true
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie),
      )
    })

    const renewDeliveryLease = Effect.fn("Scheduler.renewDeliveryLease")(function* (row: DeliveryRow) {
      const now = Date.now()
      const renewed = yield* db
        .update(ScheduledEventDeliveryTable)
        .set({ lease_expires_at: now + LEASE_MS, time_updated: now })
        .where(deliveryClaimCondition(row))
        .returning({ id: ScheduledEventDeliveryTable.id })
        .get()
        .pipe(Effect.orDie)
      return renewed !== undefined
    })

    const cancelDeliveryForPolicy = Effect.fn("Scheduler.cancelDeliveryForPolicy")(function* (
      row: DeliveryRow,
      now: number,
    ) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const cancelled = yield* tx
                .update(ScheduledEventDeliveryTable)
                .set({
                  status: "cancelled",
                  lease_owner: null,
                  lease_expires_at: null,
                  last_error: "proactive messaging is not subscribed or is paused",
                  time_updated: now,
                })
                .where(deliveryClaimCondition(row))
                .returning({ id: ScheduledEventDeliveryTable.id })
                .get()
              if (!cancelled) return false
              yield* tx
                .update(ScheduledEventTable)
                .set({
                  status: "cancelled",
                  last_error: null,
                  time_updated: now,
                })
                .where(eq(ScheduledEventTable.id, row.event_id))
                .run()
              yield* tx
                .insert(ScheduledEventAuditTable)
                .values(
                  auditValues({
                    eventID: row.event_id,
                    action: "cancelled",
                    outcome: "policy",
                    reason: "proactive messaging is not subscribed or is paused",
                    occurrenceAt: row.occurrence_at,
                    deliveryKey: row.delivery_key,
                    now,
                  }),
                )
                .run()
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const dispatch = Effect.fn("Scheduler.dispatch")((row: DeliveryRow, now: number, profile?: Profile.Runtime) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (row.event_type !== "reminder" && (!profile?.proactive || profile.proactivePaused)) {
            yield* cancelDeliveryForPolicy(row, now)
            return false
          }
          const deliverScope: TrustPolicy.ContentScope = profile?.kind === "companion" ? "personal" : "project"
          const flow = yield* trustPolicy.decide({
            action: "reminder.deliver",
            source: deliverScope,
            destination: deliverScope,
            actor: row.profile_id ?? "reminder",
          })
          if (flow.decision === "deny") {
            yield* cancelDeliveryForPolicy(row, now)
            return false
          }
          const attemptCount = row.attempt_count
          const leaseLost = yield* Ref.make(false)
      yield* Effect.sleep(Duration.millis(LEASE_MS / 3)).pipe(
        Effect.andThen(renewDeliveryLease(row)),
        Effect.flatMap((renewed) => (renewed ? Effect.void : Ref.set(leaseLost, true))),
        Effect.repeat(Schedule.spaced(Duration.millis(LEASE_MS / 3))),
        Effect.forkScoped,
      )
      yield* events.publish(
        SchedulerEvent.Due,
        {
          id: row.event_id,
          ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
          profileID: row.profile_id,
          ...(row.session_id ? { sessionID: row.session_id } : {}),
          eventType: row.event_type,
          title: row.title,
          body: row.body,
          scheduleAt: row.occurrence_at,
          occurrenceAt: row.occurrence_at,
          deliveryKey: row.delivery_key,
          attemptCount,
        },
        {
          location: {
            directory: AbsolutePath.make(row.directory),
            ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
          },
        },
      )
          if (yield* Ref.get(leaseLost)) return false
          return yield* deliverySucceeded(row, now)
        }),
      ),
    )

    const pruneAudit = Effect.fn("Scheduler.pruneAudit")(function* (now: number) {
      yield* db
        .delete(ScheduledEventAuditTable)
        .where(lt(ScheduledEventAuditTable.time_created, now - AUDIT_RETENTION_MS))
        .run()
        .pipe(Effect.orDie)
    })

    const checkFollows = Effect.fn("Scheduler.checkFollows")(function* (now: number) {
      const follows = yield* follow.list()
      yield* Effect.forEach(
        follows,
        (item) =>
          Effect.gen(function* () {
            if (item.status !== "active") return
            if (!item.directory) return
            // Not due yet.
            if (item.lastCheckedAt && now - item.lastCheckedAt < item.checkIntervalMinutes * 60_000) return
            const value = computeValueFor(item, now)
            // topic/release/price need a network search (auto-detection is P1
            // deferred); deadline is computed locally.
            if (value === null) return
            // Change-driven: only notify when the observed value actually moved.
            if (item.lastValue === value) return
            yield* follow.updateLastValue({ id: item.id, value })
            yield* events.publish(
              SchedulerEvent.Due,
              {
                id: item.id,
                eventType: "follow",
                title: item.topic,
                body: value,
                scheduleAt: now,
                occurrenceAt: now,
                deliveryKey: `follow:${item.id}`,
                attemptCount: 0,
                profileID: item.profileID ?? "companion",
              },
              {
                location: {
                  directory: AbsolutePath.make(item.directory),
                },
              },
            )
          }),
        { concurrency: "unbounded", discard: true },
      )
    })

    // Dynamic proactive-care body: combine the Companion's recent relationship
    // memories with today's daily summary when available. Read-only composition
    // for the same actor (the profile's own memory), going straight to the
    // tables so the scheduler keeps no LLM/provider dependencies.
    const composeCheckInBody = Effect.fn("Scheduler.composeCheckInBody")(function* (profileID: string, now: number) {
      const memories = yield* db
        .select({ content: MemoryTable.content })
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.scope, "relationship"),
            eq(MemoryTable.profile_id, profileID),
            eq(MemoryTable.status, "active"),
          ),
        )
        .orderBy(desc(MemoryTable.id))
        .limit(3)
        .all()
        .pipe(Effect.orDie)
      const summary = yield* db
        .select({ content: DailySummaryTable.content })
        .from(DailySummaryTable)
        .where(eq(DailySummaryTable.date, localDateKey(now)))
        .get()
        .pipe(Effect.orDie)
      const parts: string[] = []
      if (summary) parts.push(`今天的每日小结：${overviewFromContent(summary.content)}`)
      if (memories.length > 0) parts.push(`最近记得你：${memories.map((m) => m.content).join("；")}`)
      parts.push("想聊聊今天过得怎么样吗？")
      return parts.join("\n")
    })

    // Auto-trigger proactive care for subscribed profiles. Runs on every tick;
    // the per-profile guards (quiet hours, no stacking, frequency, idle) keep it
    // from creating more than proactiveFrequency allows. The created event flows
    // through the normal claim→stage→dispatch pipeline, which re-checks quiet
    // hours and frequency before delivery.
    const autoScheduleCheckIns = Effect.fn("Scheduler.autoScheduleCheckIns")(function* (now: number) {
      const infos = yield* profiles.list()
      for (const info of infos) {
        if (!info.proactive) continue
        const runtime = yield* profiles.runtime(info.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!runtime || runtime.proactivePaused) continue
        if (runtime.quietHours && isQuiet(now, runtime.quietHours)) continue
        const profileID = info.id
        // No stacking: never create a second proactive event while one is pending.
        const pending = yield* db
          .select({ id: ScheduledEventTable.id })
          .from(ScheduledEventTable)
          .where(
            and(
              eq(ScheduledEventTable.profile_id, profileID),
              inArray(ScheduledEventTable.type, ["check_in", "follow_up"]),
              inArray(ScheduledEventTable.status, ["pending", "dispatching"]),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (pending) continue
        // Frequency: same 24h window / min-interval as evaluateAndStage.
        const deliveredSince = now - 24 * 60 * 60 * 1000
        const effectiveDeliveryAt = sql<number>`coalesce(${ScheduledEventDeliveryTable.time_delivered}, ${ScheduledEventDeliveryTable.occurrence_at})`
        const last = yield* db
          .select({
            count: sql<number>`count(*)`,
            latest: sql<number | null>`max(${effectiveDeliveryAt})`,
          })
          .from(ScheduledEventDeliveryTable)
          .where(
            and(
              eq(ScheduledEventDeliveryTable.profile_id, profileID),
              inArray(ScheduledEventDeliveryTable.event_type, ["check_in", "follow_up"]),
              inArray(ScheduledEventDeliveryTable.status, ["pending", "retry", "delivered"]),
              gte(effectiveDeliveryAt, deliveredSince),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        const minInterval = runtime.proactiveFrequency.minIntervalMinutes * 60 * 1000
        if (
          (last?.count ?? 0) >= runtime.proactiveFrequency.maxPerDay ||
          (last?.latest !== null && last?.latest !== undefined && now - last.latest < minInterval)
        )
          continue
        // Idle: don't interrupt an active conversation for this profile, and
        // require an established session (nothing to check in on otherwise, and
        // no notification link target).
        const latestSession = yield* db
          .select({ id: SessionTable.id, updated: SessionTable.time_updated })
          .from(SessionTable)
          .where(eq(SessionTable.profile_id, profileID))
          .orderBy(desc(SessionTable.time_updated))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!latestSession) continue
        if (now - (latestSession.updated ?? 0) < AUTO_CHECK_IN_IDLE_MS) continue
        const timezone = runtime.quietHours?.timezone ?? "UTC"
        const body = yield* composeCheckInBody(profileID, now)
        yield* create({
          profileID,
          sessionID: latestSession.id,
          type: "check_in",
          title: "主动关心",
          body,
          scheduleAt: now,
          timezone,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("proactive check-in scheduling failed", {
              profileID,
              error: Cause.squash(cause),
            }),
          ),
        )
      }
    })

    const tick = Effect.fn("Scheduler.tick")(function* (now = Date.now()) {
      yield* autoScheduleCheckIns(now)
      yield* pruneAudit(now)
      yield* failExhaustedDeliveries(now)
      yield* recoverExpiredDeliveries(now)
      yield* checkFollows(now)
      const rows = yield* claimSeries(now)
      const profileEntries = yield* Effect.forEach(
        [...new Set(rows.map((row) => row.profile_id))],
        (profileID) =>
          profiles
            .runtime(Profile.ID.make(profileID))
            .pipe(Effect.orDie, Effect.map((profile) => [profileID, profile] as const)),
        { concurrency: "unbounded" },
      )
      const profileMap = new Map(profileEntries)
      const groups = Map.groupBy(rows, (row) =>
        row.type === "reminder"
          ? `reminder:${row.id}`
          : `proactive:${row.profile_id}:${row.workspace_id ?? `directory:${row.directory}`}`,
      )
      yield* Effect.forEach(
        groups.values(),
        (group) =>
          Effect.forEach(
            group,
            (row) => evaluateAndStage(row, now, profileMap.get(row.profile_id)!),
            { concurrency: 1, discard: true },
          ),
        { concurrency: CLAIM_LIMIT, discard: true },
      )

      const deliveries = yield* claimDeliveries(now)
      const deliveryProfileEntries = yield* Effect.forEach(
        [...new Set(deliveries.filter((row) => row.event_type !== "reminder").map((row) => row.profile_id))],
        (profileID) =>
          profiles
            .runtime(Profile.ID.make(profileID))
            .pipe(Effect.orDie, Effect.map((profile) => [profileID, profile] as const)),
        { concurrency: "unbounded" },
      )
      const deliveryProfiles = new Map(deliveryProfileEntries)
      const delivered = yield* Effect.forEach(
        deliveries,
        (row) => dispatch(row, now, deliveryProfiles.get(row.profile_id)),
        { concurrency: CLAIM_LIMIT },
      )
      return delivered.filter(Boolean).length
    })

    yield* tick().pipe(
      Effect.catchCause((cause) => Effect.logError("scheduler tick failed", { cause })),
      Effect.repeat(Schedule.spaced(Duration.seconds(15))),
      Effect.forkScoped,
    )

    return Service.of({ create, list, count, update, cancel, audit, tick })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, EventV2Bridge.node, Profile.node, TrustPolicy.node, followNode],
})

export * as Scheduler from "./index"
