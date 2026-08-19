import { SessionV1 } from "@newhorse/core/v1/session"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { SessionProjector } from "@newhorse/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { GlobalBus } from "@/bus/global"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@newhorse/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { Ripgrep } from "@newhorse/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@newhorse/core/provider"
import { ModelV2 } from "@newhorse/core/model"
import { Profile } from "@/profile"
import { Memory } from "@/memory"
import { ContinuityGrant } from "@/continuity-grant"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
    prepareRename: () => Effect.succeed([]),
    rename: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    storedAuth: () => Effect.succeed({}),
    debugAuthProvider: () => Effect.die("unexpected MCP auth"),
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  Profile.node,
  Memory.node,
  ContinuityGrant.node,
])

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

function makeHttp() {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, runtimeFlags],
    [InstanceStore.bootstrapNode, noopBootstrap],
  ] as const
  return LayerNode.compile(root, replacements)
}

const it = testEffect(makeHttp())

import { Database } from "@newhorse/core/database/database"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const testProviderConfig = {
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

const writeConfig = Effect.fn("status-delivery.writeConfig")(function* (dir: string, llmURL: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    `${dir}/opencode.json`,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        test: {
          ...testProviderConfig.provider.test,
          options: {
            ...testProviderConfig.provider.test.options,
            baseURL: llmURL,
          },
        },
      },
    }),
  )
})

const user = Effect.fn("status-delivery.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

function captureStatusEvents() {
  return Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const seen: Array<{ type: string; data: { status?: { type?: string } }; location?: { directory?: string } }> = []
    const off = yield* events.listen((event) => {
      seen.push({
        type: event.type,
        data: event.data as { status?: { type?: string } },
        location: event.location as { directory?: string } | undefined,
      })
      return Effect.void
    })
    yield* Effect.addFinalizer(() => off)

    const busEvents: Array<{
      directory?: string
      payload: { type?: string; properties?: { sessionID?: string; status?: { type?: string } } }
    }> = []
    const busHandler = (event: {
      directory?: string
      payload: { type?: string; properties?: { sessionID?: string; status?: { type?: string } } }
    }) => {
      if (event.payload?.type === "session.status" || event.payload?.type === "session.idle") busEvents.push(event)
    }
    yield* Effect.sync(() => GlobalBus.on("event", busHandler))
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", busHandler)))

    // The production /api/event SSE handler (packages/server) and the instance
    // /event handler both consume the same underlying EventV2 listener array the
    // bridge wraps, so this captures the app's v2 transport exactly.
    const coreSeen: Array<{
      type: string
      data: { sessionID: string; status?: { type?: string } }
      location?: { directory?: string }
    }> = []
    yield* events.listen((event) => {
      if (event.type !== "session.status" && event.type !== "session.idle") return Effect.void
      coreSeen.push({
        type: event.type,
        data: event.data as { sessionID: string; status?: { type?: string } },
        location: event.location as { directory?: string } | undefined,
      })
      return Effect.void
    }).pipe(Effect.flatMap((off) => Effect.addFinalizer(() => off)))

    return { seen, busEvents, coreSeen }
  })
}

it.instance(
  "session.status busy event reaches the GlobalBus stream with a directory during a run",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const llm = yield* TestLLMServer
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service

      const captured = yield* captureStatusEvents()
      const { seen, busEvents } = captured

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      yield* llm.hang
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const sts = yield* SessionStatus.Service
          const s = yield* sts.get(chat.id)
          return s.type === "busy" ? (true as const) : undefined
        }),
        "session never became busy",
      )
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const sts = yield* SessionStatus.Service
          const s = yield* sts.get(chat.id)
          return s.type === "idle" ? (true as const) : undefined
        }),
        "session never returned to idle after cancel",
      )

      const statusEvents = seen.filter((e) => e.type === SessionStatus.Event.Status.type)
      expect(statusEvents.length).toBeGreaterThan(0)
      expect(busEvents.length).toBeGreaterThan(0)
      const busEvent = busEvents[0]!
      expect(busEvent.directory).toBe(test.directory)
      const properties = busEvent.payload.properties!
      expect(properties.sessionID).toBe(chat.id)
      expect(properties.status?.type).toBe("busy")
    }),
  10_000,
)

it.instance(
  "session.status busy then idle events reach both GlobalBus and the core EventV2 stream on normal completion",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const llm = yield* TestLLMServer
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service

      const captured = yield* captureStatusEvents()
      const { seen, busEvents, coreSeen } = captured

      yield* writeConfig(test.directory, llm.url)
      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      yield* llm.text("hello from the mock")
      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.role).toBe("assistant")
      yield* pollWithTimeout(
        Effect.sync(() =>
          coreSeen.some((e) => e.type === "session.status" && e.data.status?.type === "idle") ? (true as const) : undefined,
        ),
        "core EventV2 stream never saw the terminal idle",
      )

      // The bridge listen sees the full status sequence.
      const statusSequence = seen
        .filter((e) => e.type === SessionStatus.Event.Status.type)
        .map((e) => e.data?.status?.type)
      expect(statusSequence.includes("busy")).toBe(true)
      expect(statusSequence.includes("idle")).toBe(true)
      expect(statusSequence.indexOf("busy")).toBeLessThan(statusSequence.indexOf("idle"))

      // GlobalBus carries busy + idle with the directory attached.
      const busStatus = busEvents.map((e) => e.payload.properties?.status?.type ?? e.payload.type)
      expect(busStatus.includes("busy")).toBe(true)
      expect(busStatus.includes("idle")).toBe(true)
      expect(busEvents.every((e) => e.directory === test.directory)).toBe(true)

      // The core EventV2 stream (the app's /api/event transport) carries the
      // same events with a location that points at the test directory.
      const coreTypes = coreSeen.map((e) => e.type)
      expect(coreTypes.includes("session.status")).toBe(true)
      expect(coreTypes.some((t) => t === "session.idle")).toBe(true)
      const located = coreSeen.filter((e) => e.location?.directory === test.directory)
      expect(located.length).toBeGreaterThan(0)

      // Idle also removes the persisted map entry so a fresh status() fetch is idle.
      const sts = yield* SessionStatus.Service
      expect((yield* sts.get(chat.id)).type).toBe("idle")
    }),
  15_000,
)
