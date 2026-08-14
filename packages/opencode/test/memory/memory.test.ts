import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@newhorse/core/database/database"
import { Memory, detectSensitive } from "@/memory"
import { WorkspaceMetadataRef, WorkspaceRef } from "@/effect/instance-ref"
import { MessageID } from "@/session/schema"
import { ProjectV2 } from "@newhorse/core/project"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Memory.node, Database.node])))

function personal<A, E, R>(effect: Effect.Effect<A, E, R>, id = "wrk_memory_personal") {
  return effect.pipe(
    Effect.provideService(WorkspaceMetadataRef, {
      id: WorkspaceV2.ID.make(id),
      type: "personal",
      projectID: ProjectV2.ID.global,
    }),
  )
}

describe("Memory", () => {
  it.instance("stores explicit memory as active", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "preference",
        content: "prefers dark mode",
        provenance: "user_explicit",
      })

      expect(saved.status).toBe("active")
      expect(saved.scope).toBe("workspace")
      expect(saved.id.startsWith("mem_")).toBe(true)
    }),
  )

  // Inference must never become an asserted fact on its own.
  it.instance("stores inferred memory as a proposal only", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "fact",
        content: "probably lives in Berlin",
        provenance: "model_inferred",
      })

      expect(saved.status).toBe("proposed")

      const retrieved = yield* memory.retrieve()
      expect(retrieved.find((item) => item.id === saved.id)).toBeUndefined()
    }),
  )

  it.instance("promotes a proposal once accepted", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "fact",
        content: "uses pnpm",
        provenance: "model_inferred",
      })
      yield* memory.decide({ id: saved.id, decision: "accept" })

      const retrieved = yield* memory.retrieve()
      expect(retrieved.some((item) => item.id === saved.id)).toBe(true)
    }),
  )

  it.instance("refuses to store credentials", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const exit = yield* memory
        .save({
          kind: "fact",
          content: "my api key is sk-abcdef0123456789ghijkl",
          provenance: "user_explicit",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* memory.list()).toEqual([])
    }),
  )

  it.instance("forgotten memory is no longer retrievable", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "goal",
        content: "learn Rust",
        provenance: "user_explicit",
      })
      yield* memory.forget(saved.id)

      expect(yield* memory.list()).toEqual([])
      expect(yield* memory.retrieve()).toEqual([])
    }),
  )

  it.instance("expired memory is not retrieved", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({
        kind: "event",
        content: "standup at 10",
        provenance: "user_explicit",
        expiresAt: Date.now() - 1000,
      })

      expect(yield* memory.retrieve()).toEqual([])
      expect((yield* memory.list()).length).toBe(1)
    }),
  )

  it.instance("maintain expires past-dated rows", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({
        kind: "event",
        content: "standup at 10",
        provenance: "user_explicit",
        expiresAt: Date.now() - 1000,
      })

      // Before maintain the expired row is still listed (just not retrieved).
      expect((yield* memory.list()).length).toBe(1)
      const result = yield* memory.maintain()
      expect(result.expired).toBe(1)
      // After maintain it is demoted to deleted and no longer surfaces.
      expect(yield* memory.list()).toEqual([])
      expect(yield* memory.count()).toBe(0)
    }),
  )

  it.instance("rejects a source message without a source session", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const result = yield* memory
        .save({
          kind: "fact",
          content: "unattached source",
          provenance: "user_explicit",
          sourceMessageID: MessageID.make("msg_unattached"),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* memory.list()).toEqual([])
    }),
  )

  it.instance("retrieves only relationship memory for the requested profile", () =>
    personal(
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const companion = yield* memory.save({
          kind: "relationship",
          content: "likes a quiet check-in",
          provenance: "user_explicit",
          profileID: "companion",
        })
        const assistant = yield* memory.save({
          kind: "relationship",
          content: "assistant relationship",
          provenance: "user_explicit",
          profileID: "assistant",
        })
        yield* memory.save({
          kind: "preference",
          content: "not relationship memory",
          provenance: "user_explicit",
          profileID: "companion",
        })

        const rejected = yield* memory
          .save({
            kind: "relationship",
            content: "global relationship must be rejected",
            provenance: "user_explicit",
            profileID: "companion",
            scope: "user_global",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)

        expect((yield* memory.retrieve()).map((item) => item.content)).toEqual(["not relationship memory"])
        // The Memory Center viewer (list/page/count) is the user's own memory
        // hub: in a personal context it shows relationship memories too, even
        // without a profileID. Retrieval isolation stays in `retrieve`.
        const listed = yield* memory.list()
        expect(listed.map((item) => item.content)).toEqual(
          expect.arrayContaining(["not relationship memory", "likes a quiet check-in", "assistant relationship"]),
        )
        expect(yield* memory.count()).toBe(3)
        expect((yield* memory.export()).map((item) => item.content)).toEqual(["not relationship memory"])
        const retrieved = yield* memory.retrieve({ profileID: "companion", relationshipOnly: true })
        expect(retrieved.map((item) => item.id)).toEqual([companion.id])
        expect(yield* memory.forget(assistant.id, "workspace", "companion")).toBe(false)
        expect(yield* memory.forget(companion.id, "workspace", "companion")).toBe(true)
      }),
    ),
  )

  it.instance("searches relationship memory content", () =>
    personal(
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.save({
          kind: "relationship",
          content: "prefers a quiet evening walk",
          provenance: "user_explicit",
          profileID: "companion",
        })
        yield* memory.save({
          kind: "relationship",
          content: "enjoys strong coffee",
          provenance: "user_explicit",
          profileID: "companion",
        })
        const found = yield* memory.search({ query: "walk", profileID: "companion", relationshipOnly: true })
        expect(found.map((item) => item.content)).toEqual(["prefers a quiet evening walk"])
        expect((yield* memory.search({ query: "walk", profileID: "companion", relationshipOnly: true, limit: 10 })).length).toBe(1)
        expect((yield* memory.search({ query: "nothing-here" })).length).toBe(0)
      }),
    ),
  )

  it.instance("blocks relationship lifecycle operations without the matching profile", () =>
    personal(
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const active = yield* memory.save({
          kind: "relationship",
          content: "companion active",
          provenance: "user_explicit",
          profileID: "companion",
        })
        const proposed = yield* memory.save({
          kind: "relationship",
          content: "companion proposal",
          provenance: "model_inferred",
          profileID: "companion",
        })

        expect(yield* memory.update({ id: active.id, content: "changed without profile" })).toBeUndefined()
        expect(
          yield* memory.update({ id: active.id, content: "changed by assistant", profileID: "assistant" }),
        ).toBeUndefined()
        expect(yield* memory.pause({ id: active.id, paused: true })).toBeUndefined()
        expect(yield* memory.pause({ id: active.id, paused: true, profileID: "assistant" })).toBeUndefined()
        expect(yield* memory.decide({ id: proposed.id, decision: "accept" })).toBeUndefined()
        expect(yield* memory.decide({ id: proposed.id, decision: "accept", profileID: "assistant" })).toBeUndefined()
        expect(yield* memory.forget(active.id)).toBe(false)
        expect(yield* memory.forget(active.id, "workspace", "assistant")).toBe(false)

        expect(
          yield* memory.update({ id: active.id, content: "companion changed", profileID: "companion" }),
        ).toMatchObject({ content: "companion changed" })
        expect(yield* memory.pause({ id: active.id, paused: true, profileID: "companion" })).toMatchObject({
          status: "paused",
        })
        expect(yield* memory.decide({ id: proposed.id, decision: "accept", profileID: "companion" })).toMatchObject({
          status: "active",
        })
      }),
    ),
  )

  it.instance("requires matching Profile authority when converting Memory to relationship", () =>
    personal(
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const ordinary = yield* memory.save({
          kind: "preference",
          content: "companion preference",
          provenance: "user_explicit",
          profileID: "companion",
        })

        expect(yield* memory.update({ id: ordinary.id, kind: "relationship" })).toBeUndefined()
        expect(yield* memory.update({ id: ordinary.id, kind: "relationship", profileID: "assistant" })).toBeUndefined()
        expect(yield* memory.update({ id: ordinary.id, kind: "relationship", profileID: "companion" })).toMatchObject({
          kind: "relationship",
          profileID: "companion",
        })
      }),
    ),
  )

  it.instance("counts records without crossing profile or workspace scope", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const workspace = WorkspaceV2.ID.make("wrk_memory_count")
      yield* memory.save({
        kind: "preference",
        content: "global preference",
        provenance: "user_explicit",
        scope: "user_global",
      })
      yield* memory
        .save({
          kind: "fact",
          content: "assistant fact",
          provenance: "user_explicit",
          profileID: "assistant",
        })
        .pipe(Effect.provideService(WorkspaceRef, workspace))
      yield* memory
        .save({
          kind: "relationship",
          content: "companion relationship",
          provenance: "model_inferred",
          profileID: "companion",
        })
        .pipe(
          Effect.provideService(WorkspaceRef, workspace),
          Effect.provideService(WorkspaceMetadataRef, {
            id: workspace,
            type: "personal",
            projectID: ProjectV2.ID.global,
          }),
        )

      const count = (input?: Parameters<Memory.Interface["count"]>[0]) =>
        memory.count(input).pipe(
          Effect.provideService(WorkspaceRef, workspace),
          Effect.provideService(WorkspaceMetadataRef, {
            id: workspace,
            type: "personal",
            projectID: ProjectV2.ID.global,
          }),
        )
      expect(yield* count({ profileID: "assistant" })).toBe(2)
      expect(yield* count({ profileID: "companion", status: ["active"] })).toBe(1)
      expect(yield* count({ profileID: "companion" })).toBe(2)
      expect(yield* count({ includeGlobal: false, profileID: "companion" })).toBe(1)
      expect(yield* memory.count({ profileID: "assistant" })).toBe(1)
      expect(yield* memory.count({ includeGlobal: false })).toBe(0)
    }),
  )

  it.instance("rejects sensitive content even when caller marks it normal", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const result = yield* memory
        .save({
          kind: "fact",
          content: "token: should-never-be-stored",
          provenance: "user_explicit",
          sensitivity: "normal",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* memory.list()).toEqual([])
    }),
  )

  it.instance("allows only preferences in user-global scope", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const result = yield* memory
        .save({ kind: "fact", content: "project fact", provenance: "user_explicit", scope: "user_global" })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* memory.list()).toEqual([])
    }),
  )

  it.instance("rejects relationship memory outside Personal scope", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const result = yield* memory
        .save({
          kind: "relationship",
          content: "must remain personal",
          provenance: "user_explicit",
          profileID: "companion",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* memory.list()).toEqual([])
    }),
  )

  it.instance("applies proposal decisions once and records confirmation", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({ kind: "fact", content: "uses Bun", provenance: "model_inferred" })
      const accepted = yield* memory.decide({ id: saved.id, decision: "accept" })

      expect(accepted).toMatchObject({ status: "active", provenance: "user_confirmed" })
      expect(yield* memory.decide({ id: saved.id, decision: "reject" })).toBeUndefined()
    }),
  )

  it.instance("updates, pauses, resumes, and revalidates content", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({ kind: "goal", content: "learn Rust", provenance: "user_explicit" })
      const updated = yield* memory.update({
        id: saved.id,
        kind: "preference",
        content: "prefers Rust examples",
        expiresAt: Date.now() + 60_000,
      })
      expect(updated).toMatchObject({ kind: "preference", content: "prefers Rust examples" })
      expect(updated!.timeUpdated).toBeGreaterThanOrEqual(saved.timeUpdated)

      expect(yield* memory.pause({ id: saved.id, paused: true })).toMatchObject({ status: "paused" })
      expect(yield* memory.retrieve()).toEqual([])
      expect(yield* memory.pause({ id: saved.id, paused: false })).toMatchObject({ status: "active" })
      expect(yield* memory.retrieve()).toHaveLength(1)

      const rejected = yield* memory.update({ id: saved.id, content: "password: do-not-store" }).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      expect((yield* memory.list())[0]?.content).toBe("prefers Rust examples")
    }),
  )

  it.instance("requires explicit global authority for mutation", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const global = yield* memory.save({
        kind: "preference",
        content: "answers concisely",
        provenance: "user_explicit",
        scope: "user_global",
      })

      expect(yield* memory.forget(global.id)).toBe(false)
      expect(yield* memory.forget(global.id, "user_global")).toBe(true)
    }),
  )

  it.instance("paginates with a stable descending cursor", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({ kind: "fact", content: "one", provenance: "user_explicit" })
      yield* memory.save({ kind: "fact", content: "two", provenance: "user_explicit" })
      yield* memory.save({ kind: "fact", content: "three", provenance: "user_explicit" })

      const first = yield* memory.page({ limit: 2 })
      const second = yield* memory.page({ limit: 2, cursor: first.nextCursor })
      expect(first.items.map((item) => item.content)).toEqual(["three", "two"])
      expect(first.nextCursor).toBeDefined()
      expect(second.items.map((item) => item.content)).toEqual(["one"])
      expect(second.nextCursor).toBeUndefined()
    }),
  )

  it.instance("keeps list complete while page remains bounded", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      for (let index = 0; index < 51; index++) {
        yield* memory.save({ kind: "fact", content: `record ${index}`, provenance: "user_explicit" })
      }

      expect(yield* memory.list()).toHaveLength(51)
      const page = yield* memory.page()
      expect(page.items).toHaveLength(50)
      expect(page.nextCursor).toBeDefined()
    }),
  )

  it.instance("exports only visible records and clears explicit scopes", () =>
    personal(
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.save({
          kind: "preference",
          content: "workspace",
          provenance: "user_explicit",
          profileID: "companion",
        })
        yield* memory.save({
          kind: "relationship",
          content: "relationship",
          provenance: "user_explicit",
          profileID: "companion",
        })
        yield* memory.save({
          kind: "relationship",
          content: "assistant relationship",
          provenance: "user_explicit",
          profileID: "assistant",
        })
        yield* memory.save({
          kind: "preference",
          content: "global",
          provenance: "user_explicit",
          scope: "user_global",
        })

        expect((yield* memory.export()).map((item) => item.content).toSorted()).toEqual(["global", "workspace"])
        expect((yield* memory.export({ profileID: "companion" })).map((item) => item.content).toSorted()).toEqual([
          "global",
          "relationship",
          "workspace",
        ])
        expect(Exit.isFailure(yield* memory.clear({ target: "relationship" }).pipe(Effect.exit))).toBe(true)
        expect(yield* memory.clear({ target: "relationship", profileID: "companion" })).toBe(1)
        expect((yield* memory.export({ profileID: "assistant" })).map((item) => item.content)).toContain(
          "assistant relationship",
        )
        expect(yield* memory.clear({ target: "workspace" })).toBe(2)
        expect(yield* memory.clear({ target: "user_global" })).toBe(1)
        expect(yield* memory.list()).toEqual([])
      }),
    ),
  )

  it.instance("clear removes workspace memory but keeps user_global preferences", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({ kind: "fact", content: "workspace scoped", provenance: "user_explicit" })
      const global = yield* memory.save({
        kind: "preference",
        content: "answers in Chinese",
        provenance: "user_explicit",
        scope: "user_global",
      })

      yield* memory.clear({ target: "workspace" })

      const remaining = yield* memory.list()
      expect(remaining.map((item) => item.id)).toEqual([global.id])
    }),
  )

  it.instance("searches Latin content through FTS5 trigram", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({ kind: "fact", content: "prefers dark mode hiking weekend", provenance: "user_explicit" })
      yield* memory.save({ kind: "fact", content: "likes hiking in the mountains", provenance: "user_explicit" })
      const found = yield* memory.search({ query: "hiking" })
      expect(found).toHaveLength(2)
      expect(found.map((item) => item.content).toSorted()).toEqual([
        "likes hiking in the mountains",
        "prefers dark mode hiking weekend",
      ])
    }),
  )

  it.instance("searches Chinese content through FTS5 trigram", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({ kind: "fact", content: "喜欢喝咖啡，周末去公园散步", provenance: "user_explicit" })
      const found = yield* memory.search({ query: "喝咖啡" })
      expect(found.map((item) => item.content)).toEqual(["喜欢喝咖啡，周末去公园散步"])
    }),
  )

  it.instance("falls back to LIKE for short CJK terms the trigram index cannot match", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({ kind: "fact", content: "喜欢喝咖啡", provenance: "user_explicit" })
      // 咖啡 is two characters: trigram requires >=3, so this must hit the LIKE fallback.
      expect((yield* memory.search({ query: "咖啡" })).map((item) => item.content)).toEqual(["喜欢喝咖啡"])
    }),
  )

  it.instance("stores entities at save and boosts entity matches in search", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const memory = yield* Memory.Service
      yield* memory.save({
        kind: "fact",
        content: "Prefers PostgreSQL for the projects and uses GitHub Actions",
        provenance: "user_explicit",
      })
      const saved = yield* memory.save({
        kind: "fact",
        content: "Prefers Postgres and GitHub Actions",
        provenance: "user_explicit",
      })
      const entities = yield* db.all<{ memory_id: string; normalized_text: string }>(sql`
        SELECT memory_id, normalized_text FROM memory_entity WHERE memory_id = ${saved.id} ORDER BY normalized_text
      `)
      expect(entities.map((entity) => entity.normalized_text)).toContain("postgres")
      expect(entities.map((entity) => entity.normalized_text)).toContain("github actions")

      // Query entity "postgres" fuzzy-matches the stored "PostgreSQL" entity, so
      // both memories surface and the exact term match ranks first.
      const found = yield* memory.search({ query: "postgres" })
      expect(found.length).toBeGreaterThanOrEqual(1)
      expect(found[0]!.content).toContain("Postgres")
    }),
  )

  it.instance("writes memory_history for each lifecycle transition and forget survives", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "fact",
        content: "Prefers PostgreSQL",
        provenance: "model_inferred",
      })
      const history = (id: string) =>
        db.all<{ event: string }>(sql`SELECT event FROM memory_history WHERE memory_id = ${id} ORDER BY created_at, id`)
      expect((yield* history(saved.id)).map((row) => row.event)).toEqual(["ADD"])

      yield* memory.update({ id: saved.id, content: "Prefers PostgreSQL and uses GitHub Actions" })
      expect((yield* history(saved.id)).map((row) => row.event)).toEqual(["ADD", "UPDATE"])
      yield* memory.decide({ id: saved.id, decision: "accept" })
      expect((yield* history(saved.id)).map((row) => row.event)).toEqual(["ADD", "UPDATE", "ACCEPT"])
      yield* memory.pause({ id: saved.id, paused: true })
      yield* memory.pause({ id: saved.id, paused: false })
      expect((yield* history(saved.id)).map((row) => row.event)).toEqual([
        "ADD",
        "UPDATE",
        "ACCEPT",
        "PAUSE",
        "RESUME",
      ])

      yield* memory.forget(saved.id)
      expect((yield* history(saved.id)).map((row) => row.event)).toEqual([
        "ADD",
        "UPDATE",
        "ACCEPT",
        "PAUSE",
        "RESUME",
        "DELETE",
      ])
      // Audit log outlives its memory row.
      expect(yield* db.get(sql`SELECT count(*) AS c FROM memory WHERE id = ${saved.id}`)).toEqual({ c: 0 })
    }),
  )

  it.instance("keeps history when maintain prunes rejected rows", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const memory = yield* Memory.Service
      const saved = yield* memory.save({ kind: "fact", content: "rejected fact", provenance: "model_inferred" })
      yield* memory.decide({ id: saved.id, decision: "reject" })
      yield* db.run(
        sql`UPDATE memory SET time_created = ${Date.now() - 40 * 24 * 60 * 60 * 1000} WHERE id = ${saved.id}`,
      )

      const result = yield* memory.maintain()
      expect(result.pruned).toBe(1)
      expect(yield* db.get(sql`SELECT count(*) AS c FROM memory WHERE id = ${saved.id}`)).toEqual({ c: 0 })
      expect(yield* db.get(sql`SELECT count(*) AS c FROM memory_history WHERE memory_id = ${saved.id}`)).toEqual({
        c: 2,
      })
    }),
  )
})

describe("detectSensitive", () => {
  it.effect("flags credentials and payment data", () =>
    Effect.sync(() => {
      expect(detectSensitive("token: hunter2")).toBe(true)
      expect(detectSensitive("ghp_abcdefghijklmnopqrstuvwxyz12")).toBe(true)
      expect(detectSensitive("AKIAIOSFODNN7EXAMPLE")).toBe(true)
      expect(detectSensitive("4111 1111 1111 1111")).toBe(true)
      expect(detectSensitive("ssn: 123-45-6789")).toBe(true)
      expect(detectSensitive("passport number: AB1234567")).toBe(true)
      expect(detectSensitive("home address: 123 Main Street, Springfield")).toBe(true)
      expect(detectSensitive("gps: 40.7128, -74.0060")).toBe(true)
      expect(detectSensitive("diagnosis: type 2 diabetes")).toBe(true)
      expect(detectSensitive("allergy: penicillin")).toBe(true)
      expect(detectSensitive("-----BEGIN RSA PRIVATE KEY-----")).toBe(true)
    }),
  )

  it.effect("leaves ordinary notes alone", () =>
    Effect.sync(() => {
      expect(detectSensitive("prefers dark mode")).toBe(false)
      expect(detectSensitive("buy oat milk on the way home")).toBe(false)
    }),
  )
})
