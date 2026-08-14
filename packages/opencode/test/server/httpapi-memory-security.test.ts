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
import { sql } from "drizzle-orm"
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
const assistant = Profile.ID.make("assistant")

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
    const directory = personalDirectory(`http-memory-${suffix}`)
    const workspaceID = WorkspaceV2.ID.make(`wrk_http_memory_${suffix}`)
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
        name: `http-memory-${suffix}`,
        directory,
        project_id: ProjectV2.ID.global,
      })
      .run()
      .pipe(Effect.orDie)

    const store = yield* InstanceStore.Service
    const seeded = yield* store.provide(
      { directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const memory = yield* Memory.Service
        const companionSession = yield* sessions.create({ workspaceID, profileID: companion })
        const assistantSession = yield* sessions.create({ workspaceID, profileID: assistant })
        const ordinary = yield* memory.save({
          kind: "preference",
          content: "ordinary personal preference",
          provenance: "user_explicit",
          profileID: companion,
        })
        const update = yield* memory.save({
          kind: "relationship",
          content: "companion update target",
          provenance: "user_explicit",
          profileID: companion,
        })
        const pause = yield* memory.save({
          kind: "relationship",
          content: "companion pause target",
          provenance: "user_explicit",
          profileID: companion,
        })
        const proposal = yield* memory.save({
          kind: "relationship",
          content: "companion proposal target",
          provenance: "model_inferred",
          profileID: companion,
        })
        // No-approval saves as active; mark it as a legacy proposed row so the
        // decide endpoint still has a legacy accept path to exercise.
        yield* db.run(sql`UPDATE memory SET status = 'proposed' WHERE id = ${proposal.id}`)
        const remove = yield* memory.save({
          kind: "relationship",
          content: "companion remove target",
          provenance: "user_explicit",
          profileID: companion,
        })
        const assistantRelationship = yield* memory.save({
          kind: "relationship",
          content: "assistant relationship",
          provenance: "user_explicit",
          profileID: assistant,
        })
        return {
          directory,
          workspaceID,
          companionSession,
          assistantSession,
          ordinary,
          update,
          pause,
          proposal,
          remove,
          assistantRelationship,
        }
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

describe("memory HttpApi trusted Profile routing", () => {
  it.instance("does not accept a client-declared Profile as relationship authority", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const seeded = yield* seedPersonalMemory
      const route = `workspace=${seeded.workspaceID}&directory=${encodeURIComponent(seeded.directory)}`

      const listed = yield* memoryRequest(`/memory?${route}&profileID=${companion}`, test.directory)
      expect(listed.status).toBe(200)
      expect((yield* json<Memory.Page>(listed)).items.map((item) => item.id)).toEqual([seeded.ordinary.id])

      const exported = yield* memoryRequest(`/memory/export?${route}&profileID=${companion}`, test.directory)
      expect(exported.status).toBe(200)
      expect((yield* json<Memory.Info[]>(exported)).map((item) => item.id)).toEqual([seeded.ordinary.id])

      const update = yield* memoryRequest(
        `/memory/${seeded.update.id}?${route}&profileID=${companion}`,
        test.directory,
        {
          method: "PATCH",
          ...body({ content: "unauthorized update" }),
        },
      )
      expect(update.status).toBe(400)

      const pause = yield* memoryRequest(
        `/memory/${seeded.pause.id}/pause?${route}&profileID=${companion}`,
        test.directory,
        {
          method: "POST",
          ...body({ paused: true }),
        },
      )
      expect(pause.status).toBe(400)

      const decide = yield* memoryRequest(
        `/memory/${seeded.proposal.id}/decision?${route}&profileID=${companion}`,
        test.directory,
        { method: "POST", ...body({ decision: "accept" }) },
      )
      expect(decide.status).toBe(400)

      const remove = yield* memoryRequest(
        `/memory/${seeded.remove.id}?${route}&profileID=${companion}`,
        test.directory,
        {
          method: "DELETE",
        },
      )
      expect(remove.status).toBe(400)

      const clear = yield* memoryRequest(`/memory/clear?${route}&profileID=${companion}`, test.directory, {
        method: "POST",
        ...body({ target: "relationship" }),
      })
      expect(clear.status).toBe(400)
    }),
  )

  it.instance("requires immutable Session Profile authority when converting Memory to relationship", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const seeded = yield* seedPersonalMemory
      const route = `workspace=${seeded.workspaceID}&directory=${encodeURIComponent(seeded.directory)}`

      const withoutSession = yield* memoryRequest(`/memory/${seeded.ordinary.id}?${route}`, test.directory, {
        method: "PATCH",
        ...body({ kind: "relationship" }),
      })
      expect(withoutSession.status).toBe(400)

      const wrongProfile = yield* memoryRequest(
        `/memory/${seeded.ordinary.id}?${route}&session=${seeded.assistantSession.id}`,
        test.directory,
        { method: "PATCH", ...body({ kind: "relationship" }) },
      )
      expect(wrongProfile.status).toBe(400)

      const matchingProfile = yield* memoryRequest(
        `/memory/${seeded.ordinary.id}?${route}&session=${seeded.companionSession.id}`,
        test.directory,
        { method: "PATCH", ...body({ kind: "relationship" }) },
      )
      expect(matchingProfile.status).toBe(200)
      expect(yield* json<Memory.Info>(matchingProfile)).toMatchObject({
        id: seeded.ordinary.id,
        kind: "relationship",
        profileID: companion,
      })
    }),
  )

  it.instance("enforces immutable Session Workspace and Profile across relationship lifecycle operations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const seeded = yield* seedPersonalMemory
      const conflict = `workspace=wrk_missing&directory=${encodeURIComponent(test.directory)}`
      const companionRoute = `${conflict}&session=${seeded.companionSession.id}`
      const assistantRoute = `${conflict}&session=${seeded.assistantSession.id}`

      const companionList = yield* memoryRequest(`/memory?${companionRoute}`, test.directory)
      expect(companionList.status).toBe(200)
      const companionIDs = (yield* json<Memory.Page>(companionList)).items.map((item) => item.id)
      expect(companionIDs).toContain(seeded.ordinary.id)
      expect(companionIDs).toContain(seeded.update.id)
      expect(companionIDs).not.toContain(seeded.assistantRelationship.id)

      const assistantList = yield* memoryRequest(`/memory?${assistantRoute}`, test.directory)
      expect(assistantList.status).toBe(200)
      const assistantIDs = (yield* json<Memory.Page>(assistantList)).items.map((item) => item.id)
      expect(assistantIDs).not.toContain(seeded.ordinary.id)
      expect(assistantIDs).toContain(seeded.assistantRelationship.id)
      expect(assistantIDs).not.toContain(seeded.update.id)

      for (const [path, init] of [
        [`/memory/${seeded.update.id}?${assistantRoute}`, { method: "PATCH", ...body({ content: "cross-profile" }) }],
        [`/memory/${seeded.pause.id}/pause?${assistantRoute}`, { method: "POST", ...body({ paused: true }) }],
        [
          `/memory/${seeded.proposal.id}/decision?${assistantRoute}`,
          { method: "POST", ...body({ decision: "accept" }) },
        ],
        [`/memory/${seeded.remove.id}?${assistantRoute}`, { method: "DELETE" }],
      ] as const) {
        expect((yield* memoryRequest(path, test.directory, init)).status).toBe(400)
      }

      const crossClear = yield* memoryRequest(`/memory/clear?${assistantRoute}`, test.directory, {
        method: "POST",
        ...body({ target: "relationship" }),
      })
      expect(crossClear.status).toBe(200)
      expect(yield* json<{ cleared: number }>(crossClear)).toEqual({ cleared: 1 })

      const updated = yield* memoryRequest(`/memory/${seeded.update.id}?${companionRoute}`, test.directory, {
        method: "PATCH",
        ...body({ content: "companion updated" }),
      })
      expect(updated.status).toBe(200)
      expect(yield* json<Memory.Info>(updated)).toMatchObject({ content: "companion updated" })

      const paused = yield* memoryRequest(`/memory/${seeded.pause.id}/pause?${companionRoute}`, test.directory, {
        method: "POST",
        ...body({ paused: true }),
      })
      expect(paused.status).toBe(200)
      expect(yield* json<Memory.Info>(paused)).toMatchObject({ status: "paused" })

      const decided = yield* memoryRequest(`/memory/${seeded.proposal.id}/decision?${companionRoute}`, test.directory, {
        method: "POST",
        ...body({ decision: "accept" }),
      })
      expect(decided.status).toBe(200)
      expect(yield* json<Memory.Info>(decided)).toMatchObject({ status: "active", provenance: "user_confirmed" })

      const removed = yield* memoryRequest(`/memory/${seeded.remove.id}?${companionRoute}`, test.directory, {
        method: "DELETE",
      })
      expect(removed.status).toBe(200)
      expect(yield* json<boolean>(removed)).toBe(true)

      const cleared = yield* memoryRequest(`/memory/clear?${companionRoute}`, test.directory, {
        method: "POST",
        ...body({ target: "relationship" }),
      })
      expect(cleared.status).toBe(200)
      expect(yield* json<{ cleared: number }>(cleared)).toEqual({ cleared: 3 })

      const assistantAfterClear = yield* memoryRequest(`/memory?${assistantRoute}`, test.directory)
      expect((yield* json<Memory.Page>(assistantAfterClear)).items).toEqual([])
    }),
  )
})
