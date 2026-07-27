import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Fiber, Effect, Stream } from "effect"
import { Scheduler } from "@/scheduler"
import { SchedulerEvent } from "@newhorse/schema/scheduler-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Profile } from "@/profile"
import { WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Scheduler.node, EventV2Bridge.node, Profile.node])))

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

      const paused = yield* scheduler.update({ id: first.id, paused: true })
      expect(paused?.status).toBe("paused")
      const resumed = yield* scheduler.update({ id: first.id, paused: false })
      expect(resumed?.status).toBe("pending")

      yield* scheduler.cancel(first.id)
      expect((yield* scheduler.list())[0]?.status).toBe("cancelled")
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
      const created = yield* Effect.all([scheduler.create(input), scheduler.create(input)], { concurrency: "unbounded" })

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
      expect(event?.data).toMatchObject({ id: reminder.id, title: "Drink water", body: "Take a water break" })
      expect((yield* scheduler.list())[0]?.status).toBe("delivered")
      expect(yield* scheduler.tick(now + 1000)).toBe(0)
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
      expect(yield* scheduler.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "check_in", status: "pending", scheduleAt: now + 15 * 60 * 1000 }),
          expect.objectContaining({ type: "reminder", status: "delivered" }),
        ]),
      )
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
      expect(yield* scheduler.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "reminder", status: "delivered" }),
          expect.objectContaining({ type: "check_in", status: "delivered" }),
          expect.objectContaining({ type: "follow_up", status: "pending", scheduleAt: now + 60 * 60 * 1000 }),
        ]),
      )
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
        yield* scheduler.update({ id: reminder.id, title: "Cross-workspace edit" }).pipe(
          Effect.provideService(WorkspaceRef, two),
        ),
      ).toBeUndefined()
      yield* scheduler.cancel(reminder.id).pipe(Effect.provideService(WorkspaceRef, two))

      expect((yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, one)))[0]).toMatchObject({
        title: "Owned by one",
        status: "pending",
      })
      expect(yield* scheduler.list().pipe(Effect.provideService(WorkspaceRef, two))).toEqual([])
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
