import { mkdir } from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import {
  ScheduledEventAuditTable,
  ScheduledEventDeliveryTable,
  ScheduledEventTable,
} from "@newhorse/core/scheduler/sql"
import { eq } from "drizzle-orm"
import { Deferred, Fiber, Effect, Stream } from "effect"
import { Scheduler } from "@/scheduler"
import { SchedulerEvent } from "@newhorse/schema/scheduler-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Profile } from "@/profile"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Scheduler.node, EventV2Bridge.node, Profile.node, Database.node])),
)

describe("Scheduler", () => {
  it.instance("creates reminders idempotently and supports pause resume cancel", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const input = {
        idempotencyKey: "scheduler-idempotent-test",
        profileID: "assistant",
        title: "Stretch",
        body: "Stand up and stretch",
        scheduleAt: Date.now() + 60_000,
        timezone: "UTC",
      }
      const first = yield* scheduler.create(input)
      const duplicate = yield* scheduler.create(input)
      expect(duplicate.id).toBe(first.id)
      expect((yield* scheduler.list()).map((item) => item.id)).toEqual([first.id])
      expect(yield* scheduler.count({ profileID: "assistant", status: ["pending", "paused"] })).toBe(1)

      const paused = yield* scheduler.update({ id: first.id, paused: true })
      expect(paused?.status).toBe("paused")
      const resumed = yield* scheduler.update({ id: first.id, paused: false })
      expect(resumed?.status).toBe("pending")

      yield* scheduler.cancel(first.id)
      expect((yield* scheduler.list())[0]?.status).toBe("cancelled")
      expect(yield* scheduler.count({ profileID: "assistant", status: ["pending", "paused"] })).toBe(0)
    }),
  )

  it.instance("creates one reminder for concurrent idempotent requests", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const input = {
        idempotencyKey: "scheduler-concurrent-idempotent-test",
        profileID: "assistant",
        title: "Concurrent reminder",
        body: "Only one record",
        scheduleAt: Date.now() + 60_000,
        timezone: "UTC",
      }
      const created = yield* Effect.all([scheduler.create(input), scheduler.create(input)], {
        concurrency: "unbounded",
      })

      expect(created[0].id).toBe(created[1].id)
      expect(yield* scheduler.list()).toHaveLength(1)
    }),
  )

  it.instance("rejects proactive events unless explicitly subscribed", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const exit = yield* scheduler
        .create({
          profileID: "companion",
          type: "check_in",
          title: "Check in",
          body: "How is your day going?",
          scheduleAt: Date.now() + 60_000,
          timezone: "UTC",
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* scheduler.list()).toEqual([])
    }),
  )

  it.instance("delivers an explicit reminder once", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const events = yield* EventV2Bridge.Service
      const due = yield* events.subscribe(SchedulerEvent.Due).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const now = Date.now()
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "Drink water",
        body: "Take a water break",
        scheduleAt: now,
        timezone: "UTC",
      })

      expect(yield* scheduler.tick(now)).toBe(1)
      const [event] = Array.from(yield* Fiber.join(due))
      const deliveryKey = `${reminder.id}:${now}`
      expect(event?.data).toMatchObject({
        id: reminder.id,
        title: "Drink water",
        body: "Take a water break",
        scheduleAt: now,
        occurrenceAt: now,
        deliveryKey,
        attemptCount: 1,
      })
      const { db } = yield* Database.Service
      const delivery = yield* db
        .select()
        .from(ScheduledEventDeliveryTable)
        .where(eq(ScheduledEventDeliveryTable.event_id, reminder.id))
        .get()
        .pipe(Effect.orDie)
      expect(delivery).toMatchObject({
        event_id: reminder.id,
        occurrence_at: now,
        delivery_key: deliveryKey,
        profile_id: "assistant",
        event_type: "reminder",
        title: "Drink water",
        body: "Take a water break",
        status: "delivered",
        attempt_count: 1,
        max_attempts: 5,
        lease_owner: null,
        time_delivered: now,
      })
      const audits = yield* db
        .select()
        .from(ScheduledEventAuditTable)
        .where(eq(ScheduledEventAuditTable.event_id, reminder.id))
        .all()
        .pipe(Effect.orDie)
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "staged", occurrence_at: now, delivery_key: deliveryKey }),
          expect.objectContaining({ action: "delivered", occurrence_at: now, delivery_key: deliveryKey }),
        ]),
      )
      expect((yield* scheduler.list())[0]?.status).toBe("delivered")
      expect(yield* scheduler.tick(now + 1000)).toBe(0)
    }),
  )

  it.instance("redelivers the same delivery key after publish-before-ack interruption", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const events = yield* EventV2Bridge.Service
      const published: string[] = []
      const started = yield* Deferred.make<void>()
      const block = yield* Deferred.make<void>()
      let first = true
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== SchedulerEvent.Due.type) return Effect.void
        const data = event.data as { deliveryKey: string }
        published.push(data.deliveryKey)
        if (!first) return Effect.void
        first = false
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(block)))
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const now = Date.now()
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "Crash window",
        body: "Preserve delivery identity",
        scheduleAt: now,
        timezone: "UTC",
      })
      const running = yield* scheduler.tick(now).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(running)

      expect(published).toEqual([`${reminder.id}:${now}`])
      expect(yield* scheduler.tick(now + 30_000)).toBe(0)
      expect(yield* scheduler.tick(now + 90_000)).toBe(1)
      expect(published).toEqual([`${reminder.id}:${now}`, `${reminder.id}:${now}`])
    }),
  )

  it.instance("marks reminders outside the missed window as failed", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.now()
      yield* scheduler.create({
        profileID: "assistant",
        title: "Old reminder",
        body: "This should not fire after a day",
        scheduleAt: now - 25 * 60 * 60 * 1000,
        timezone: "UTC",
      })

      expect(yield* scheduler.tick(now)).toBe(0)
      expect((yield* scheduler.list())[0]).toMatchObject({ status: "failed", lastError: "missed delivery window" })
    }),
  )

  it.instance("applies quiet hours only to proactive care", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const profiles = yield* Profile.Service
      const now = Date.UTC(2026, 0, 1, 23, 30)
      yield* profiles.update(Profile.ID.make("companion"), {
        proactive: true,
        quietHours: { start: "22:00", end: "08:00", timezone: "UTC" },
      })
      yield* scheduler.create({
        profileID: "companion",
        type: "check_in",
        title: "Evening check-in",
        body: "How was your day?",
        scheduleAt: now,
        timezone: "UTC",
      })
      yield* scheduler.create({
        profileID: "companion",
        title: "Medicine",
        body: "Take your prescribed medicine",
        scheduleAt: now,
        timezone: "UTC",
      })

      expect(yield* scheduler.tick(now)).toBe(1)
      const rows = yield* scheduler.list()
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "check_in", status: "pending", scheduleAt: now }),
          expect.objectContaining({ type: "reminder", status: "delivered" }),
        ]),
      )
      const deferred = rows.find((item) => item.type === "check_in")
      const { db } = yield* Database.Service
      const stored = yield* db
        .select({ scheduleAt: ScheduledEventTable.schedule_at, eligibleAt: ScheduledEventTable.eligible_at })
        .from(ScheduledEventTable)
        .where(eq(ScheduledEventTable.id, deferred!.id))
        .get()
        .pipe(Effect.orDie)
      expect(stored).toEqual({ scheduleAt: now, eligibleAt: now + 15 * 60 * 1000 })
    }),
  )

  it.instance("rate limits proactive care without counting reminders", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const profiles = yield* Profile.Service
      const now = Date.UTC(2030, 0, 1, 12)
      yield* profiles.update(Profile.ID.make("companion"), {
        proactive: true,
        proactiveFrequency: { maxPerDay: 1, minIntervalMinutes: 60 },
      })
      expect(yield* profiles.runtime(Profile.ID.make("companion"))).toMatchObject({
        proactive: true,
        proactiveFrequency: { maxPerDay: 1, minIntervalMinutes: 60 },
      })
      yield* scheduler.create({
        profileID: "companion",
        title: "Explicit reminder",
        body: "User requested this",
        scheduleAt: now,
        timezone: "UTC",
      })
      yield* scheduler.create({
        profileID: "companion",
        type: "check_in",
        title: "First check-in",
        body: "How are you?",
        scheduleAt: now,
        timezone: "UTC",
      })
      yield* scheduler.create({
        profileID: "companion",
        type: "follow_up",
        title: "Second check-in",
        body: "Following up",
        scheduleAt: now,
        timezone: "UTC",
      })

      const delivered = yield* scheduler.tick(now)
      const rows = yield* scheduler.list()
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "reminder", status: "delivered" }),
          expect.objectContaining({ type: "check_in", status: "delivered" }),
          expect.objectContaining({ type: "follow_up", status: "pending", scheduleAt: now }),
        ]),
      )
      const deferred = rows.find((item) => item.type === "follow_up")
      const { db } = yield* Database.Service
      const stored = yield* db
        .select({ scheduleAt: ScheduledEventTable.schedule_at, eligibleAt: ScheduledEventTable.eligible_at })
        .from(ScheduledEventTable)
        .where(eq(ScheduledEventTable.id, deferred!.id))
        .get()
        .pipe(Effect.orDie)
      expect(stored).toEqual({ scheduleAt: now, eligibleAt: now + 60 * 60 * 1000 })
      expect(delivered).toBe(2)
    }),
  )

  it.instance("cancels proactive care when consent is withdrawn before delivery", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const profiles = yield* Profile.Service
      const now = Date.now()
      yield* profiles.update(Profile.ID.make("companion"), { proactive: true })
      yield* scheduler.create({
        profileID: "companion",
        type: "check_in",
        title: "Check in",
        body: "How are you?",
        scheduleAt: now,
        timezone: "UTC",
      })
      yield* profiles.update(Profile.ID.make("companion"), { proactive: false })

      expect(yield* scheduler.tick(now)).toBe(0)
      expect((yield* scheduler.list())[0]?.status).toBe("cancelled")
    }),
  )

  it.instance("recovers expired outbox claims without stealing active leases", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const events = yield* EventV2Bridge.Service
      const now = Date.now()
      const expired = yield* scheduler.create({
        profileID: "assistant",
        title: "Recover expired delivery",
        body: "Deliver after restart",
        scheduleAt: now,
        timezone: "UTC",
      })
      const active = yield* scheduler.create({
        profileID: "assistant",
        title: "Keep active lease",
        body: "Do not steal",
        scheduleAt: now,
        timezone: "UTC",
      })
      const { db } = yield* Database.Service
      const seed = (eventID: string, leaseExpiresAt: number) =>
        db.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(ScheduledEventTable)
                .set({ status: "dispatching", lease_owner: null, lease_expires_at: null })
                .where(eq(ScheduledEventTable.id, eventID))
                .run()
              yield* tx
                .insert(ScheduledEventDeliveryTable)
                .values({
                  id: `sdl_${eventID}`,
                  event_id: eventID,
                  occurrence_at: now,
                  delivery_key: `${eventID}:${now}`,
                  workspace_id: null,
                  directory: (yield* TestInstance).directory,
                  profile_id: "assistant",
                  session_id: null,
                  event_type: "reminder",
                  title: eventID === expired.id ? "Recover expired delivery" : "Keep active lease",
                  body: eventID === expired.id ? "Deliver after restart" : "Do not steal",
                  status: "pending",
                  available_at: now,
                  attempt_count: 0,
                  max_attempts: 5,
                  lease_owner: "crashed-owner",
                  lease_token: 7,
                  lease_expires_at: leaseExpiresAt,
                  last_error: null,
                  time_delivered: null,
                  time_created: now,
                  time_updated: now,
                })
                .run()
            }),
          { behavior: "immediate" },
        )
      yield* seed(expired.id, now - 1)
      yield* seed(active.id, now + 120_000)
      const due = yield* events.subscribe(SchedulerEvent.Due).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      expect(yield* scheduler.tick(now)).toBe(0)
      expect(
        yield* db
          .select({
            status: ScheduledEventDeliveryTable.status,
            token: ScheduledEventDeliveryTable.lease_token,
            availableAt: ScheduledEventDeliveryTable.available_at,
          })
          .from(ScheduledEventDeliveryTable)
          .where(eq(ScheduledEventDeliveryTable.event_id, expired.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "retry", token: 7, availableAt: now + 60_000 })
      expect(yield* scheduler.tick(now + 60_000)).toBe(1)
      expect(Array.from(yield* Fiber.join(due))[0]?.data).toMatchObject({
        id: expired.id,
        deliveryKey: `${expired.id}:${now}`,
      })
      expect(
        yield* db
          .select({ status: ScheduledEventDeliveryTable.status, token: ScheduledEventDeliveryTable.lease_token })
          .from(ScheduledEventDeliveryTable)
          .where(eq(ScheduledEventDeliveryTable.event_id, expired.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "delivered", token: 8 })
      expect(
        yield* db
          .select({ action: ScheduledEventAuditTable.action, outcome: ScheduledEventAuditTable.outcome })
          .from(ScheduledEventAuditTable)
          .where(eq(ScheduledEventAuditTable.event_id, expired.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(expect.arrayContaining([{ action: "retry_scheduled", outcome: "lease_expired" }]))
      expect(
        yield* db
          .select({ status: ScheduledEventDeliveryTable.status, token: ScheduledEventDeliveryTable.lease_token })
          .from(ScheduledEventDeliveryTable)
          .where(eq(ScheduledEventDeliveryTable.event_id, active.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "pending", token: 7 })
    }),
  )

  it.instance("fails an occurrence after the bounded crash-recovery attempt budget", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.now()
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "Exhausted reminder",
        body: "Do not publish a sixth time",
        scheduleAt: now,
        timezone: "UTC",
      })
      const { db } = yield* Database.Service
      yield* db
        .update(ScheduledEventTable)
        .set({ status: "dispatching" })
        .where(eq(ScheduledEventTable.id, reminder.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ScheduledEventDeliveryTable)
        .values({
          id: `sdl_${reminder.id}`,
          event_id: reminder.id,
          occurrence_at: now,
          delivery_key: `${reminder.id}:${now}`,
          workspace_id: null,
          directory: (yield* TestInstance).directory,
          profile_id: "assistant",
          session_id: null,
          event_type: "reminder",
          title: reminder.title,
          body: reminder.body,
          status: "pending",
          available_at: now,
          attempt_count: 5,
          max_attempts: 5,
          lease_owner: "crashed-owner",
          lease_token: 5,
          lease_expires_at: now - 1,
          last_error: null,
          time_delivered: null,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* scheduler.tick(now)).toBe(0)
      expect((yield* scheduler.list())[0]).toMatchObject({
        status: "failed",
        attemptCount: 5,
        lastError: "delivery attempts exhausted",
      })
      expect(
        yield* db
          .select({ status: ScheduledEventDeliveryTable.status, attemptCount: ScheduledEventDeliveryTable.attempt_count })
          .from(ScheduledEventDeliveryTable)
          .where(eq(ScheduledEventDeliveryTable.event_id, reminder.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "failed", attemptCount: 5 })
      expect(
        yield* db
          .select({ action: ScheduledEventAuditTable.action, outcome: ScheduledEventAuditTable.outcome })
          .from(ScheduledEventAuditTable)
          .where(eq(ScheduledEventAuditTable.event_id, reminder.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(expect.arrayContaining([{ action: "failed", outcome: "attempts_exhausted" }]))
    }),
  )

  it.instance("claims a due reminder only once across concurrent ticks", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const events = yield* EventV2Bridge.Service
      const due = yield* events.subscribe(SchedulerEvent.Due).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const now = Date.now()
      yield* scheduler.create({
        profileID: "assistant",
        title: "Once",
        body: "Deliver once",
        scheduleAt: now,
        timezone: "UTC",
      })

      const results = yield* Effect.all([scheduler.tick(now), scheduler.tick(now)], { concurrency: "unbounded" })
      expect(results[0] + results[1]).toBe(1)
      expect(Array.from(yield* Fiber.join(due))).toHaveLength(1)
      expect((yield* scheduler.list())[0]?.status).toBe("delivered")
    }),
  )

  it.instance("does not repeat an occurrence when the clock moves backward", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.now()
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "Clock rollback",
        body: "Deliver only once",
        scheduleAt: now,
        timezone: "UTC",
      })

      expect(yield* scheduler.tick(now)).toBe(1)
      expect(yield* scheduler.tick(now - 60_000)).toBe(0)
      expect(yield* scheduler.tick(now + 60_000)).toBe(0)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: ScheduledEventDeliveryTable.id })
          .from(ScheduledEventDeliveryTable)
          .where(eq(ScheduledEventDeliveryTable.event_id, reminder.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.instance("cancels a staged occurrence before it can be claimed", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.now()
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "Cancel staged",
        body: "Do not publish",
        scheduleAt: now,
        timezone: "UTC",
      })
      const { db } = yield* Database.Service
      yield* db
        .insert(ScheduledEventDeliveryTable)
        .values({
          id: "sdl_cancel_staged",
          event_id: reminder.id,
          occurrence_at: now,
          delivery_key: `${reminder.id}:${now}`,
          workspace_id: null,
          directory: (yield* TestInstance).directory,
          profile_id: "assistant",
          session_id: null,
          event_type: "reminder",
          title: reminder.title,
          body: reminder.body,
          status: "pending",
          available_at: now,
          attempt_count: 0,
          max_attempts: 5,
          lease_owner: null,
          lease_token: 0,
          lease_expires_at: null,
          last_error: null,
          time_delivered: null,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* scheduler.cancel(reminder.id)).toBe(true)
      expect(yield* scheduler.tick(now)).toBe(0)
      expect(
        yield* db
          .select({ status: ScheduledEventDeliveryTable.status })
          .from(ScheduledEventDeliveryTable)
          .where(eq(ScheduledEventDeliveryTable.event_id, reminder.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "cancelled" })
    }),
  )

  it.instance("does not promise cancellation while a delivery lease is active", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.now()
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "In-flight cancellation",
        body: "Wait for the active publisher",
        scheduleAt: now,
        timezone: "UTC",
      })
      const { db } = yield* Database.Service
      yield* db
        .insert(ScheduledEventDeliveryTable)
        .values({
          id: "sdl_active_cancel",
          event_id: reminder.id,
          occurrence_at: now,
          delivery_key: `${reminder.id}:${now}`,
          workspace_id: null,
          directory: (yield* TestInstance).directory,
          profile_id: "assistant",
          session_id: null,
          event_type: "reminder",
          title: reminder.title,
          body: reminder.body,
          status: "pending",
          available_at: now,
          attempt_count: 1,
          max_attempts: 5,
          lease_owner: "active-owner",
          lease_token: 1,
          lease_expires_at: now + 30_000,
          last_error: null,
          time_delivered: null,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* scheduler.cancel(reminder.id)).toBe(false)
      expect((yield* scheduler.list())[0]?.status).toBe("pending")
    }),
  )

  it.instance("cancels staged proactive delivery after consent is withdrawn", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const profiles = yield* Profile.Service
      const now = Date.now()
      yield* profiles.update(Profile.ID.make("companion"), { proactive: true })
      const reminder = yield* scheduler.create({
        profileID: "companion",
        type: "check_in",
        title: "Consent recheck",
        body: "Do not publish after withdrawal",
        scheduleAt: now,
        timezone: "UTC",
      })
      const { db } = yield* Database.Service
      yield* db
        .insert(ScheduledEventDeliveryTable)
        .values({
          id: "sdl_consent_recheck",
          event_id: reminder.id,
          occurrence_at: now,
          delivery_key: `${reminder.id}:${now}`,
          workspace_id: null,
          directory: (yield* TestInstance).directory,
          profile_id: "companion",
          session_id: null,
          event_type: "check_in",
          title: reminder.title,
          body: reminder.body,
          status: "pending",
          available_at: now,
          attempt_count: 0,
          max_attempts: 5,
          lease_owner: null,
          lease_token: 0,
          lease_expires_at: null,
          last_error: null,
          time_delivered: null,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* profiles.update(Profile.ID.make("companion"), { proactive: false })

      expect(yield* scheduler.tick(now)).toBe(0)
      expect((yield* scheduler.list())[0]?.status).toBe("cancelled")
      expect(
        yield* db
          .select({ status: ScheduledEventDeliveryTable.status })
          .from(ScheduledEventDeliveryTable)
          .where(eq(ScheduledEventDeliveryTable.event_id, reminder.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "cancelled" })
    }),
  )

  it.instance("keeps proactive frequency limits isolated by workspace", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const profiles = yield* Profile.Service
      const one = WorkspaceV2.ID.make("wrk_frequency_one")
      const two = WorkspaceV2.ID.make("wrk_frequency_two")
      const now = Date.UTC(2030, 0, 1, 12)
      yield* profiles.update(Profile.ID.make("companion"), {
        proactive: true,
        proactiveFrequency: { maxPerDay: 1, minIntervalMinutes: 60 },
      })
      const create = (workspace: WorkspaceV2.ID, title: string) =>
        scheduler
          .create({
            profileID: "companion",
            type: "check_in",
            title,
            body: "Workspace-scoped care",
            scheduleAt: now,
            timezone: "UTC",
          })
          .pipe(Effect.provideService(WorkspaceRef, workspace))

      yield* create(one, "Workspace one")
      yield* create(two, "Workspace two")

      const delivered = yield* scheduler.tick(now)
      expect((yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, one)))[0]?.status).toBe("delivered")
      expect((yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, two)))[0]?.status).toBe("delivered")
      expect(delivered).toBe(2)
    }),
  )

  it.instance("keeps reminder mutations isolated by workspace", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const one = WorkspaceV2.ID.make("wrk_mutation_one")
      const two = WorkspaceV2.ID.make("wrk_mutation_two")
      const reminder = yield* scheduler
        .create({
          profileID: "assistant",
          title: "Owned by one",
          body: "Do not mutate from two",
          scheduleAt: Date.now() + 60_000,
          timezone: "UTC",
        })
        .pipe(Effect.provideService(WorkspaceRef, one))

      expect(
        yield* scheduler
          .update({ id: reminder.id, title: "Cross-workspace edit" })
          .pipe(Effect.provideService(WorkspaceRef, two)),
      ).toBeUndefined()
      yield* scheduler.cancel(reminder.id).pipe(Effect.provideService(WorkspaceRef, two))

      expect((yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, one)))[0]).toMatchObject({
        title: "Owned by one",
        status: "pending",
      })
      expect(yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, two))).toEqual([])
    }),
  )

  it.instance("keeps workspace-less scheduler operations isolated by directory", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const test = yield* TestInstance
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die(new Error("Test instance context unavailable"))
      const first = path.join(test.directory, "one")
      const second = path.join(test.directory, "two")
      yield* Effect.promise(() => Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]))
      const inDirectory = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(InstanceRef, { ...instance, directory }))
      const create = (directory: string, title: string) =>
        inDirectory(
          directory,
          scheduler.create({
            idempotencyKey: "shared-directory-key",
            profileID: "assistant",
            title,
            body: "Directory-scoped reminder",
            scheduleAt: Date.now() + 60_000,
            timezone: "UTC",
          }),
        )

      const one = yield* create(first, "Directory one")
      const two = yield* create(second, "Directory two")

      expect(one.id).not.toBe(two.id)
      expect((yield* inDirectory(first, scheduler.list())).map((item) => item.id)).toEqual([one.id])
      expect(yield* inDirectory(first, scheduler.count())).toBe(1)
      expect(
        yield* inDirectory(first, scheduler.update({ id: two.id, title: "Cross-directory edit" })),
      ).toBeUndefined()
      yield* inDirectory(first, scheduler.cancel(two.id))
      expect((yield* inDirectory(first, scheduler.list()))[0]).toMatchObject({
        id: one.id,
        title: "Directory one",
        status: "pending",
      })

      const duplicate = yield* create(first, "Ignored duplicate title")
      expect(duplicate.id).toBe(one.id)
    }),
  )

  it.instance("advances recurring reminders and applies misfire policy without ending the series", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.UTC(2030, 0, 10, 12)
      const daily = 24 * 60 * 60 * 1000
      const caughtUp = yield* scheduler.create({
        profileID: "assistant",
        title: "Daily review",
        body: "Review the day",
        scheduleAt: now - 3 * daily,
        timezone: "UTC",
        recurrenceRule: "FREQ=DAILY",
        misfirePolicy: "catch_up_once",
      })
      const skipped = yield* scheduler.create({
        profileID: "assistant",
        title: "Skipped review",
        body: "Skip old occurrences",
        scheduleAt: now - 3 * daily,
        timezone: "UTC",
        recurrenceRule: "FREQ=DAILY",
        misfirePolicy: "skip",
      })

      expect(yield* scheduler.tick(now)).toBe(1)
      expect(yield* scheduler.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: caughtUp.id, status: "pending", scheduleAt: now + daily, lastFiredAt: now }),
          expect.objectContaining({ id: skipped.id, status: "pending", scheduleAt: now + daily, lastFiredAt: undefined }),
        ]),
      )
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ eventID: ScheduledEventDeliveryTable.event_id, occurrenceAt: ScheduledEventDeliveryTable.occurrence_at })
          .from(ScheduledEventDeliveryTable)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ eventID: caughtUp.id, occurrenceAt: now }])
      expect(
        yield* db
          .select({ action: ScheduledEventAuditTable.action, eventID: ScheduledEventAuditTable.event_id })
          .from(ScheduledEventAuditTable)
          .where(eq(ScheduledEventAuditTable.action, "skipped"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ action: "skipped", eventID: skipped.id }])
    }),
  )

  it.instance("pauses and resumes future recurring occurrences", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.now()
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "Recurring pause",
        body: "Pause future generation",
        scheduleAt: now,
        timezone: "UTC",
        recurrenceRule: "FREQ=WEEKLY;INTERVAL=2",
      })
      expect((yield* scheduler.update({ id: reminder.id, paused: true }))?.status).toBe("paused")
      expect(yield* scheduler.tick(now)).toBe(0)
      expect((yield* scheduler.update({ id: reminder.id, paused: false }))?.status).toBe("pending")
      expect(yield* scheduler.tick(now)).toBe(1)
      expect((yield* scheduler.list())[0]).toMatchObject({ status: "pending", recurrenceRule: "FREQ=WEEKLY;INTERVAL=2" })
    }),
  )

  it.instance("paginates owned audit and prunes records older than retention", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const reminder = yield* scheduler.create({
        profileID: "assistant",
        title: "Audit reminder",
        body: "Inspect lifecycle",
        scheduleAt: Date.now() + 60_000,
        timezone: "UTC",
      })
      yield* scheduler.update({ id: reminder.id, title: "Updated audit reminder" })
      yield* scheduler.update({ id: reminder.id, paused: true })
      const first = yield* scheduler.audit(reminder.id, { limit: 2 })
      expect(first?.items).toHaveLength(2)
      expect(first?.nextCursor).toBeDefined()
      const second = yield* scheduler.audit(reminder.id, { limit: 2, cursor: first?.nextCursor })
      expect(second?.items).toHaveLength(1)
      expect(new Set([...(first?.items ?? []), ...(second?.items ?? [])].map((item) => item.action))).toEqual(
        new Set(["created", "updated", "paused"]),
      )

      const { db } = yield* Database.Service
      const oldID = "sha_00000000000000000000000000"
      yield* db
        .insert(ScheduledEventAuditTable)
        .values({
          id: oldID,
          event_id: reminder.id,
          action: "updated",
          outcome: "old",
          reason: null,
          occurrence_at: null,
          delivery_key: null,
          time_created: Date.now() - 91 * 24 * 60 * 60 * 1000,
        })
        .run()
        .pipe(Effect.orDie)
      yield* scheduler.tick(Date.now())
      expect(
        yield* db
          .select({ id: ScheduledEventAuditTable.id })
          .from(ScheduledEventAuditTable)
          .where(eq(ScheduledEventAuditTable.id, oldID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.instance("scopes idempotency by workspace and profile", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const one = WorkspaceV2.ID.make("wrk_scheduler_one")
      const two = WorkspaceV2.ID.make("wrk_scheduler_two")
      const create = (profileID: string) =>
        scheduler.create({
          idempotencyKey: "shared-key",
          profileID,
          title: "Scoped",
          body: "Scoped reminder",
          scheduleAt: Date.now() + 60_000,
          timezone: "UTC",
        })

      const first = yield* create("assistant").pipe(Effect.provideService(WorkspaceRef, one))
      const otherProfile = yield* create("companion").pipe(Effect.provideService(WorkspaceRef, one))
      const otherWorkspace = yield* create("assistant").pipe(Effect.provideService(WorkspaceRef, two))

      expect(new Set([first.id, otherProfile.id, otherWorkspace.id]).size).toBe(3)
      expect(yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, one))).toHaveLength(2)
      expect(yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, two))).toHaveLength(1)
    }),
  )
})
