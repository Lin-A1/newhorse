import { SessionV1 } from "@newhorse/core/v1/session"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import type { Hooks } from "@newhorse/plugin"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { LLMEvent } from "@newhorse/llm"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@newhorse/core/provider"
import { ModelV2 } from "@newhorse/core/model"
import { SessionProjector } from "@newhorse/core/session/projector"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

type CompleteInput = {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  messageID: string
  parts: SessionV1.Part[]
}

/**
 * Mock Plugin.Service that records `session.complete` triggers and mutates the
 * output per `behavior`. `subscribed` controls whether `list()` reports a
 * `session.complete` subscriber, exercising the processor's no-subscriber gate.
 */
function completePlugin(options: {
  subscribed: boolean
  behavior?: (input: CompleteInput, output: { continue: boolean; context: string[] }) => void
}) {
  const calls: CompleteInput[] = []
  const layer = Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, input: Input, output: Output) => {
      if (name !== "session.complete") return Effect.succeed(output)
      return Effect.sync(() => {
        const inputValue = input as unknown as CompleteInput
        const outputValue = output as unknown as { continue: boolean; context: string[] }
        calls.push(inputValue)
        options.behavior?.(inputValue, outputValue)
        return output
      })
    },
    list: () => Effect.succeed(options.subscribed ? ([{ "session.complete": async () => {} }] as Hooks[]) : []),
    init: () => Effect.void,
  })
  return { layer, calls }
}

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])

// Env backed by the HTTP TestLLMServer (real LLM streaming).
function serverEnv(plugin: Layer.Layer<Plugin.Service>) {
  const replacements: LayerNode.Replacements = [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [Plugin.node, plugin],
  ]
  return LayerNode.compile(
    LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
    replacements,
  )
}

// Env backed by a custom LLM.Service (no HTTP server needed).
function customLlmEnv(plugin: Layer.Layer<Plugin.Service>, llm: Layer.Layer<LLM.Service>) {
  const replacements: LayerNode.Replacements = [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [Plugin.node, plugin],
    [LLM.node, llm],
  ]
  return LayerNode.compile(root, replacements)
}

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const streamInput = (input: { user: SessionV1.User; sessionID: SessionID; model: Provider.Model }) =>
  ({
    user: input.user,
    sessionID: input.sessionID,
    model: input.model,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: "hi" }],
    tools: {},
  }) satisfies LLM.StreamInput

// Deterministic tool-call round: the assistant called `lookup` (provider
// executed), which failed, and the step finished with reason "tool-calls".
const toolCallLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ),
  }),
)

const noSubscriber = completePlugin({ subscribed: false })
const continueTrue = completePlugin({
  subscribed: true,
  behavior: (_input, output) => {
    output.continue = true
    output.context = ["Continue working"]
  },
})
const continueFalse = completePlugin({
  subscribed: true,
  behavior: (_input, output) => {
    output.continue = false
    output.context = ["Ignored"]
  },
})
const toolRound = completePlugin({ subscribed: true })

const itNoSubscriber = testEffect(serverEnv(noSubscriber.layer))
const itContinueTrue = testEffect(serverEnv(continueTrue.layer))
const itContinueFalse = testEffect(serverEnv(continueFalse.layer))
const itToolRound = testEffect(customLlmEnv(toolRound.layer, toolCallLLM))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

itNoSubscriber.live("session.complete does nothing when no plugin subscribes", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { processors, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process(
          streamInput({
            user: parent,
            sessionID: chat.id,
            model: mdl,
          }),
        )
        const messages = yield* session.messages({ sessionID: chat.id })

        expect(value).toBe("continue")
        expect(noSubscriber.calls).toEqual([])
        expect(messages.at(-1)?.info.role).toBe("assistant")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itContinueTrue.live("session.complete injects a synthetic continuation turn when continue:true", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { processors, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process(
          streamInput({
            user: parent,
            sessionID: chat.id,
            model: mdl,
          }),
        )
        const messages = yield* session.messages({ sessionID: chat.id })
        const last = messages.at(-1)
        const text = last?.parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(continueTrue.calls).toHaveLength(1)
        expect(continueTrue.calls[0]?.sessionID).toBe(chat.id)
        expect(continueTrue.calls[0]?.agent).toBe("build")
        expect(continueTrue.calls[0]?.model).toEqual({ providerID: ref.providerID, modelID: ref.modelID })
        expect(continueTrue.calls[0]?.messageID).toBe(msg.id)
        expect(continueTrue.calls[0]?.parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
        expect(last?.info.role).toBe("user")
        expect(text?.text).toBe("Continue working")
        expect(text?.synthetic).toBe(true)
        expect(text?.metadata).toEqual({ session_complete_continue: true })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itContinueFalse.live("session.complete does not inject when continue is false", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { processors, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process(
          streamInput({
            user: parent,
            sessionID: chat.id,
            model: mdl,
          }),
        )
        const messages = yield* session.messages({ sessionID: chat.id })

        expect(value).toBe("continue")
        expect(continueFalse.calls).toHaveLength(1)
        expect(messages.at(-1)?.info.role).toBe("assistant")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itToolRound.live("session.complete is not fired on tool-call rounds", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { processors, provider } = yield* boot()

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process(
          streamInput({
            user: parent,
            sessionID: chat.id,
            model: mdl,
          }),
        )
        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(handle.message.finish).toBe("tool-calls")
        expect(toolRound.calls).toEqual([])
        expect(parts.some((part) => part.type === "tool")).toBe(true)
      }),
    { config: cfg },
  ),
)
