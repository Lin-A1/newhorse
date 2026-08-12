import { afterEach, describe, expect } from "bun:test"
import { WorkspaceTable } from "@newhorse/core/control-plane/workspace.sql"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { ProjectV2 } from "@newhorse/core/project"
import { AbsolutePath } from "@newhorse/core/schema"
import { ProjectTable } from "@newhorse/core/project/sql"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { mkdir, rm } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Memory } from "@/memory"
import { personalDirectory } from "@/control-plane/adapters/personal"
import { WorkspaceMetadataRef, WorkspaceRef } from "@/effect/instance-ref"
import { Profile } from "@/profile"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Memory.node, Database.node])), httpApiLayer),
)

const companion = Profile.ID.make("companion")

const json = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.map((value) => value as A))

const body = (value: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
})

const memoryRequest = (path: string, directory: string, init?: RequestInit) => requestInDirectory(path, directory, init)

const seedPersonalMemory = Effect.acquireRelease(
  Effect.gen(function* () {
    const suffix = Math.random().toString(36).slice(2)
    const directory = personalDirectory(`http-memory-history-${suffix}`)
    const workspaceID = WorkspaceV2.ID.make(`wrk_http_memory_history_${suffix}`)
    yield* Effect.promise(() => mkdir(directory, { recursive: true }))

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
        type: "personal",
        name: `http-memory-history-${suffix}`,
        directory,
        project_id: ProjectV2.ID.global,
      })
      .run()
      .pipe(Effect.orDie)

    const store = yield* InstanceStore.Service
    const seeded = yield* store.provide(
      { directory },
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const saved = yield* memory.save({
          kind: "preference",
          content: "audit trail target",
          provenance: "user_explicit",
          profileID: companion,
        })
        return { directory, workspaceID, saved }
      }).pipe(
        Effect.provideService(WorkspaceRef, workspaceID),
        Effect.provideService(WorkspaceMetadataRef, {
          id: workspaceID,
          type: "personal",
          projectID: ProjectV2.ID.global,
        }),
      ),
    )
    return seeded
  }),
  (seeded) => Effect.promise(() => rm(seeded.directory, { recursive: true, force: true })),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("memory HttpApi history endpoint", () => {
  it.instance("returns the audit trail for a Memory, oldest first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const seeded = yield* seedPersonalMemory
      const route = `workspace=${seeded.workspaceID}&directory=${encodeURIComponent(seeded.directory)}`

      const afterSave = yield* memoryRequest(
        `/memory/${seeded.saved.id}/history?${route}`,
        test.directory,
      )
      expect(afterSave.status).toBe(200)
      const saveHistory = yield* json<Memory.HistoryInfo[]>(afterSave)
      expect(saveHistory).toHaveLength(1)
      expect(saveHistory[0]).toMatchObject({
        memoryID: seeded.saved.id,
        event: "ADD",
        newContent: "audit trail target",
      })
      // Optional fields serialize as null when absent (HttpApi wire format).
      expect(saveHistory[0].oldContent).toBeNull()

      const updated = yield* memoryRequest(`/memory/${seeded.saved.id}?${route}`, test.directory, {
        method: "PATCH",
        ...body({ content: "audit trail edited" }),
      })
      expect(updated.status).toBe(200)

      const afterUpdate = yield* memoryRequest(`/memory/${seeded.saved.id}/history?${route}`, test.directory)
      expect(afterUpdate.status).toBe(200)
      const updateHistory = yield* json<Memory.HistoryInfo[]>(afterUpdate)
      expect(updateHistory.map((entry) => entry.event)).toEqual(["ADD", "UPDATE"])
      expect(updateHistory[1]).toMatchObject({
        memoryID: seeded.saved.id,
        event: "UPDATE",
        oldContent: "audit trail target",
        newContent: "audit trail edited",
      })
      // created_at ascending: the ADD precedes the UPDATE.
      expect(updateHistory[0].createdAt).toBeLessThanOrEqual(updateHistory[1].createdAt)
    }),
  )

  it.instance("keeps history after the Memory is deleted", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const seeded = yield* seedPersonalMemory
      const route = `workspace=${seeded.workspaceID}&directory=${encodeURIComponent(seeded.directory)}`

      const removed = yield* memoryRequest(`/memory/${seeded.saved.id}?${route}`, test.directory, {
        method: "DELETE",
      })
      expect(removed.status).toBe(200)

      const history = yield* memoryRequest(`/memory/${seeded.saved.id}/history?${route}`, test.directory)
      expect(history.status).toBe(200)
      const entries = yield* json<Memory.HistoryInfo[]>(history)
      expect(entries.map((entry) => entry.event)).toEqual(["ADD", "DELETE"])
    }),
  )

  it.instance("returns an empty audit trail for an unknown Memory id", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const seeded = yield* seedPersonalMemory
      const route = `workspace=${seeded.workspaceID}&directory=${encodeURIComponent(seeded.directory)}`

      const history = yield* memoryRequest(`/memory/mem_does_not_exist/history?${route}`, test.directory)
      expect(history.status).toBe(200)
      expect(yield* json<Memory.HistoryInfo[]>(history)).toEqual([])
    }),
  )
})
