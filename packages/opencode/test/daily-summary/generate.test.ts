import { describe, expect } from "bun:test"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { ProjectV2 } from "@newhorse/core/project"
import { ProjectTable } from "@newhorse/core/project/sql"
import { AbsolutePath } from "@newhorse/core/schema"
import { SessionSchema } from "@newhorse/core/session/schema"
import { SessionTable } from "@newhorse/core/session/sql"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { DailySummary } from "@/daily-summary"
import { Profile } from "@/profile"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// The scheduler fiber (`maybeGenerateToday`) forks at layer build; pin the
// companion runtime to dailySummary:false so it is a no-op regardless of the
// wall clock the suite runs under.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const companionRuntime: Profile.Runtime = {
  id: Profile.ID.make("companion"),
  kind: "companion",
  name: "Companion",
  personaVersion: 2,
  memory: "ask",
  proactive: false,
  proactivePaused: false,
  proactiveFrequency: { maxPerDay: 3, minIntervalMinutes: 120 },
  dailySummary: false,
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      DailySummary.node,
      Database.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [Profile.node, Layer.mock(Profile.Service, { runtime: () => Effect.succeed(companionRuntime) })],
      [InstanceStore.bootstrapNode, noopBootstrap],
    ],
  ),
)

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

/** Insert a root session row directly (bypasses the projector). */
const seedSession = (
  db: Database.Interface["db"],
  input: { profile: string; directory: string; updated?: number; model?: { id: string; providerID: string } },
) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const sessionID = SessionSchema.ID.make(`ses_daily_generate_${crypto.randomUUID()}`)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.global,
        profile_id: input.profile,
        slug: sessionID,
        directory: AbsolutePath.make(input.directory),
        title: input.profile === "companion" ? "Companion" : "Work session",
        version: "0.0.0-test",
        model: input.model,
        time_created: input.updated ?? Date.now(),
        time_updated: input.updated ?? Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
    return sessionID
  })

describe("daily-summary generate", () => {
  it.live("generate persists a real LLM overview, not the fallback", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* seedSession(db, { profile: "work", directory: dir })
          yield* llm.text("## 今日概览\ngenerate 路径生成成功。")

          const report = yield* (yield* DailySummary.Service).generate({ date: Date.now() })

          expect(report).toBeDefined()
          expect(report?.overview).toContain("generate 路径生成成功")
          expect(report?.overview).not.toContain("LLM 暂不可用")
          expect(report?.sessions).toHaveLength(1)

          // Persisted: a second read returns the same stored report.
          const stored = yield* (yield* DailySummary.Service).get({ date: Date.now() })
          expect(stored?.overview).toContain("generate 路径生成成功")
        }),
      { config: (url) => providerCfg(url) },
    ),
  )

  it.live("falls back to the anchor session model when the default model is stale", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          // The anchor session records a real model...
          yield* seedSession(db, {
            profile: "work",
            directory: dir,
            model: { id: "test-model", providerID: "test" },
          })
          yield* llm.text("## 今日概览\n锚点模型兜底成功。")

          const report = yield* (yield* DailySummary.Service).draft({ date: Date.now() })

          // ...but the config's default model points at a model that no longer
          // exists, so only the anchor-model fallback can produce a real recap.
          expect(report?.overview).toContain("锚点模型兜底成功")
          expect(report?.overview).not.toContain("LLM 暂不可用")
        }),
      { config: (url) => ({ ...providerCfg(url), model: "test/removed-model" }) },
    ),
  )

  it.live("draft returns undefined when there is no activity at all", () =>
    provideTmpdirServer(
      ({ dir }) =>
        Effect.gen(function* () {
          const report = yield* (yield* DailySummary.Service).draft({ date: Date.now() })
          expect(report).toBeUndefined()
        }),
      { config: (url) => providerCfg(url) },
    ),
  )
})
