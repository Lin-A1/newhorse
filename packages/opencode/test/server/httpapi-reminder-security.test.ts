import { afterEach, describe, expect } from "bun:test"
import { WorkspaceTable } from "@newhorse/core/control-plane/workspace.sql"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { ProjectV2 } from "@newhorse/core/project"
import { ProjectTable } from "@newhorse/core/project/sql"
import { AbsolutePath } from "@newhorse/core/schema"
import { SessionSchema } from "@newhorse/core/session/schema"
import { SessionTable } from "@newhorse/core/session/sql"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Scheduler } from "@/scheduler"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Database.node), httpApiLayer))

const json = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.map((value) => value as A))

const body = (value: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
})

const reminderPayload = (title: string) => ({
  title,
  body: `${title} body`,
  scheduleAt: Date.now() + 60_000,
  timezone: "UTC",
})

const seedSessions = Effect.gen(function* () {
  const test = yield* TestInstance
  const suffix = crypto.randomUUID()
  const workspaceID = WorkspaceV2.ID.make(`wrk_http_reminder_${suffix}`)
  const assistantSessionID = SessionSchema.ID.make(`ses_http_reminder_assistant_${suffix}`)
  const companionSessionID = SessionSchema.ID.make(`ses_http_reminder_companion_${suffix}`)
  const directory = AbsolutePath.make(test.directory)
  const now = Date.now()
  const { db } = yield* Database.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({
      id: workspaceID,
      type: "worktree",
      name: "reminder security",
      directory,
      project_id: ProjectV2.ID.global,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: assistantSessionID,
        project_id: ProjectV2.ID.global,
        workspace_id: workspaceID,
        profile_id: "assistant",
        slug: assistantSessionID,
        directory,
        title: "assistant reminder session",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      },
      {
        id: companionSessionID,
        project_id: ProjectV2.ID.global,
        workspace_id: workspaceID,
        profile_id: "companion",
        slug: companionSessionID,
        directory,
        title: "companion reminder session",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      },
    ])
    .run()
    .pipe(Effect.orDie)

  return { test, workspaceID, assistantSessionID, companionSessionID }
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("reminder HttpApi trusted ownership and location scope", () => {
  it.instance("uses persisted Session ownership and rejects spoofed authority fields", () =>
    Effect.gen(function* () {
      const seeded = yield* seedSessions
      const trusted = yield* requestInDirectory(
        `/reminder?session=${seeded.assistantSessionID}`,
        seeded.test.directory,
        {
          method: "POST",
          ...body(reminderPayload("Trusted assistant reminder")),
        },
      )
      expect(trusted.status).toBe(200)
      expect(yield* json<Scheduler.Info>(trusted)).toMatchObject({
        workspaceID: seeded.workspaceID,
        profileID: "assistant",
        sessionID: seeded.assistantSessionID,
      })

      const spoofed = yield* requestInDirectory(
        `/reminder?session=${seeded.assistantSessionID}`,
        seeded.test.directory,
        {
          method: "POST",
          ...body({
            ...reminderPayload("Spoofed assistant reminder"),
            profileID: "companion",
            sessionID: seeded.companionSessionID,
          }),
        },
      )
      expect(spoofed.status).toBe(200)
      expect(yield* json<Scheduler.Info>(spoofed)).toMatchObject({
        workspaceID: seeded.workspaceID,
        profileID: "assistant",
        sessionID: seeded.assistantSessionID,
      })
    }),
  )

  it.instance("isolates workspace-less reminder list and mutations by directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directoryA = path.join(test.directory, "reminder-a")
      const directoryB = path.join(test.directory, "reminder-b")
      yield* Effect.promise(() =>
        Promise.all([mkdir(directoryA, { recursive: true }), mkdir(directoryB, { recursive: true })]),
      )

      const route = (directory: string) => `directory=${encodeURIComponent(directory)}`
      const createdResponse = yield* requestInDirectory(`/reminder?${route(directoryA)}`, test.directory, {
        method: "POST",
        ...body(reminderPayload("Directory A reminder")),
      })
      expect(createdResponse.status).toBe(200)
      const created = yield* json<Scheduler.Info>(createdResponse)
      expect(created.workspaceID ?? undefined).toBeUndefined()
      expect(created.profileID).toBe("assistant")

      const foreignList = yield* requestInDirectory(`/reminder?${route(directoryB)}`, test.directory)
      expect(foreignList.status).toBe(200)
      expect(yield* json<Scheduler.Info[]>(foreignList)).toEqual([])

      const foreignUpdate = yield* requestInDirectory(`/reminder/${created.id}?${route(directoryB)}`, test.directory, {
        method: "PATCH",
        ...body({ title: "Spoofed directory update" }),
      })
      expect(foreignUpdate.status).toBe(400)

      const foreignCancel = yield* requestInDirectory(`/reminder/${created.id}?${route(directoryB)}`, test.directory, {
        method: "DELETE",
      })
      expect(foreignCancel.status).toBe(200)
      expect(yield* json<boolean>(foreignCancel)).toBe(false)

      const ownerList = yield* requestInDirectory(`/reminder?${route(directoryA)}`, test.directory)
      expect(ownerList.status).toBe(200)
      expect(yield* json<Scheduler.Info[]>(ownerList)).toEqual([
        expect.objectContaining({
          id: created.id,
          title: "Directory A reminder",
          status: "pending",
        }),
      ])
    }),
  )

  it.instance("creates Companion-owned reminders from a Companion Session route", () =>
    Effect.gen(function* () {
      const seeded = yield* seedSessions
      const response = yield* requestInDirectory(
        `/reminder?session=${seeded.companionSessionID}`,
        seeded.test.directory,
        {
          method: "POST",
          ...body(reminderPayload("Companion reminder")),
        },
      )

      expect(response.status).toBe(200)
      expect(yield* json<Scheduler.Info>(response)).toMatchObject({
        workspaceID: seeded.workspaceID,
        profileID: "companion",
        sessionID: seeded.companionSessionID,
      })
    }),
  )
})
