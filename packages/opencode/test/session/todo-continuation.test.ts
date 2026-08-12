import { describe, expect, test } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { EventV2 } from "@newhorse/core/event"
import { ModelV2 } from "@newhorse/core/model"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { ProviderV2 } from "@newhorse/core/provider"
import { SessionV1 } from "@newhorse/core/v1/session"
import { SessionStatusEvent } from "@newhorse/schema/session-status-event"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "../../src/session/session"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { Todo } from "../../src/session/todo"
import { TodoContinuation } from "../../src/session/todo-continuation"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { Effect, Layer, Option, Stream } from "effect"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")

const openTodo = (content: string): Todo.Info => ({ content, status: "pending", priority: "medium" })
const doneTodo = (content: string): Todo.Info => ({ content, status: "completed", priority: "low" })

const editableAgent: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: [
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "write", pattern: "*", action: "allow" },
  ],
  options: {},
}

const readOnlyAgent: Agent.Info = {
  name: "researcher",
  mode: "primary",
  permission: [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "write", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
  ],
  options: {},
}

const hiddenAgent: Agent.Info = {
  name: "compaction",
  mode: "primary",
  hidden: true,
  permission: [],
  options: {},
}

const sessionID = SessionID.descending()

const user = (sessionID: SessionID): SessionV1.User => ({
  id: MessageID.ascending(),
  sessionID,
  role: "user",
  time: { created: 0 },
  agent: "build",
  model: { providerID, modelID },
})

const sessionInfo = (opts?: { parentID?: SessionID }): Session.Info =>
  ({
    id: sessionID,
    slug: "test-session",
    projectID: "@@global",
    directory: "/tmp/opencode",
    parentID: opts?.parentID,
    title: "Test session",
    version: "1.0.0",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }) as Session.Info

const job = (overrides: Partial<BackgroundJob.Info> = {}): BackgroundJob.Info => ({
  id: "job_1",
  type: "test",
  status: "running",
  started_at: 0,
  ...overrides,
})

describe("todo-continuation trigger conditions", () => {
  test("hasIncompleteTodos", () => {
    expect(TodoContinuation.hasIncompleteTodos([openTodo("a"), doneTodo("b")])).toBe(true)
    expect(TodoContinuation.hasIncompleteTodos([doneTodo("a"), { ...openTodo("b"), status: "cancelled" }])).toBe(false)
    expect(TodoContinuation.hasIncompleteTodos([])).toBe(false)
  })

  test("todoProgress", () => {
    const todos = [doneTodo("a"), openTodo("b"), doneTodo("c"), { ...openTodo("d"), status: "in_progress" }]
    expect(TodoContinuation.todoProgress(todos)).toEqual({ completed: 2, total: 4 })
  })

  test("isReadOnlyAgent skips read-only and unknown agents", () => {
    expect(TodoContinuation.isReadOnlyAgent(readOnlyAgent, undefined)).toBe(true)
    expect(TodoContinuation.isReadOnlyAgent(editableAgent, undefined)).toBe(false)
    // Session-level deny can make an otherwise-editable agent read-only.
    expect(
      TodoContinuation.isReadOnlyAgent(editableAgent, [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
      ]),
    ).toBe(true)
    expect(TodoContinuation.isReadOnlyAgent(undefined, undefined)).toBe(true)
  })

  test("hasRunningBackgroundJobs matches session ownership", () => {
    expect(TodoContinuation.hasRunningBackgroundJobs([job()], sessionID)).toBe(false)
    expect(TodoContinuation.hasRunningBackgroundJobs([job({ id: sessionID })], sessionID)).toBe(true)
    expect(TodoContinuation.hasRunningBackgroundJobs([job({ metadata: { sessionId: sessionID } })], sessionID)).toBe(
      true,
    )
    expect(
      TodoContinuation.hasRunningBackgroundJobs([job({ metadata: { parentSessionId: sessionID } })], sessionID),
    ).toBe(true)
    // Completed jobs never block continuation.
    expect(TodoContinuation.hasRunningBackgroundJobs([job({ id: sessionID, status: "completed" })], sessionID)).toBe(
      false,
    )
  })

  test("decisionFor returns a Decision when all guards pass", () => {
    const decision = TodoContinuation.decisionFor({
      sessionID,
      parentID: undefined,
      permission: undefined,
      todos: [doneTodo("a"), openTodo("b")],
      lastUser: user(sessionID),
      agent: editableAgent,
      jobs: [],
      lastAbort: 0,
      now: 10_000,
    })
    expect(decision).toEqual({
      agent: "build",
      model: { providerID, modelID },
      progress: { completed: 1, total: 2 },
      open: [openTodo("b")],
    })
  })

  const base = {
    sessionID,
    parentID: undefined,
    permission: undefined,
    todos: [openTodo("a")],
    lastUser: user(sessionID),
    agent: editableAgent,
    jobs: [] as BackgroundJob.Info[],
    lastAbort: 0,
    now: 10_000,
  }

  test("decisionFor skips child sessions", () => {
    expect(TodoContinuation.decisionFor({ ...base, parentID: SessionID.descending() })).toBeUndefined()
  })

  test("decisionFor skips when all todos are closed", () => {
    expect(TodoContinuation.decisionFor({ ...base, todos: [doneTodo("a")] })).toBeUndefined()
  })

  test("decisionFor skips when no last user message", () => {
    expect(TodoContinuation.decisionFor({ ...base, lastUser: undefined })).toBeUndefined()
  })

  test("decisionFor skips hidden agents", () => {
    expect(TodoContinuation.decisionFor({ ...base, agent: hiddenAgent })).toBeUndefined()
    expect(TodoContinuation.decisionFor({ ...base, agent: undefined })).toBeUndefined()
  })

  test("decisionFor skips read-only agents", () => {
    expect(TodoContinuation.decisionFor({ ...base, agent: readOnlyAgent })).toBeUndefined()
  })

  test("decisionFor skips when a background job is running", () => {
    expect(
      TodoContinuation.decisionFor({ ...base, jobs: [job({ metadata: { sessionId: sessionID } })] }),
    ).toBeUndefined()
  })

  test("decisionFor skips a recent abort", () => {
    // lastAbort is 2s before now -> within the 3s cooldown -> skip.
    expect(TodoContinuation.decisionFor({ ...base, lastAbort: base.now - 2_000 })).toBeUndefined()
    // 4s before now -> outside the cooldown -> inject.
    expect(TodoContinuation.decisionFor({ ...base, lastAbort: base.now - 4_000 })).not.toBeUndefined()
  })
})

describe("todo-continuation prompt", () => {
  test("continuationPrompt includes progress and open tasks", () => {
    const text = TodoContinuation.continuationPrompt({
      progress: { completed: 1, total: 3 },
      open: [openTodo("fix pagination"), { ...openTodo("write tests"), status: "in_progress" }],
    })
    expect(text).toContain("[Status: 1/3 completed]")
    expect(text).toContain("fix pagination")
    expect(text).toContain("write tests")
    expect(text).toContain("[pending]")
    expect(text).toContain("[in_progress]")
  })
})

// ---------------------------------------------------------------------------
// Layer integration: idle event -> evaluate -> inject, with the recovering
// suppression marker and the abort cooldown exercised through the real event
// subscription path.
// ---------------------------------------------------------------------------

const makeEventBridge = () => {
  const listeners: Array<(event: EventV2.Payload) => Effect.Effect<void>> = []
  return Layer.succeed(
    EventV2Bridge.Service,
    EventV2Bridge.Service.of({
      publish: (definition, data) =>
        Effect.gen(function* () {
          const payload = {
            id: EventV2.ID.create(),
            type: definition.type,
            data: data as Record<string, unknown>,
          } as EventV2.Payload
          yield* Effect.forEach(
            [...listeners],
            (listener) => listener(payload).pipe(Effect.catch(() => Effect.logWarning("test listener failed"))),
            { discard: true },
          )
          return payload as never
        }),
      listen: (listener) =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        }),
      subscribe: () => Stream.never,
      all: () => Stream.never,
      durable: () => Stream.never,
      project: () => Effect.void,
      replay: () => Effect.void,
      replayAll: () => Effect.succeed(undefined),
      remove: () => Effect.void,
      claim: () => Effect.void,
    }),
  )
}

type PromptCall = { sessionID: SessionID; agent?: string; parts: readonly unknown[] }

const makeSessionPromptMock = () => {
  const calls: PromptCall[] = []
  const layer = Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      prompt: (input) =>
        Effect.sync(() => {
          calls.push({ sessionID: input.sessionID, agent: input.agent, parts: input.parts })
          return { info: input as unknown as SessionV1.User, parts: [] } as SessionV1.WithParts
        }),
      cancel: () => Effect.void,
      loop: () => Effect.succeed({ info: undefined, parts: [] } as unknown as SessionV1.WithParts),
      shell: () => Effect.succeed({ info: undefined, parts: [] } as unknown as SessionV1.WithParts),
      command: () => Effect.succeed({ info: undefined, parts: [] } as unknown as SessionV1.WithParts),
      resolvePromptParts: () => Effect.succeed([]),
    }),
  )
  return { calls, layer }
}

const makeMocks = (input: { todos: Todo.Info[]; agent: Agent.Info; parentID?: SessionID }) => {
  const sessions = Layer.succeed(
    Session.Service,
    Session.Service.of({
      get: () => Effect.succeed(sessionInfo({ parentID: input.parentID })),
      findMessage: () =>
        Effect.succeed(Option.some({ info: user(sessionID), parts: [] as SessionV1.Part[] } as SessionV1.WithParts)),
      // Unused by the enforcer:
      list: () => Effect.succeed([]),
      listGlobal: () => Effect.succeed([]),
      create: () => Effect.succeed(sessionInfo()),
      fork: () => Effect.succeed(sessionInfo()),
      touch: () => Effect.void,
      setTitle: () => Effect.void,
      setArchived: () => Effect.void,
      setMetadata: () => Effect.void,
      setAgentModel: () => Effect.void,
      setPermission: () => Effect.void,
      setProfile: () => Effect.void,
      setRevert: () => Effect.void,
      clearRevert: () => Effect.void,
      setSummary: () => Effect.void,
      setShare: () => Effect.void,
      setWorkspace: () => Effect.void,
      diff: () => Effect.succeed([]),
      messages: () => Effect.succeed([]),
      children: () => Effect.succeed([]),
      remove: () => Effect.void,
      updateMessage: (msg) => Effect.succeed(msg),
      removeMessage: ({ messageID }) => Effect.succeed(messageID),
      removePart: ({ partID }) => Effect.succeed(partID),
      getPart: () => Effect.succeed(undefined),
      updatePart: (part) => Effect.succeed(part),
      updatePartDelta: () => Effect.void,
    }),
  )

  const todos = Layer.succeed(
    Todo.Service,
    Todo.Service.of({
      update: () => Effect.void,
      get: () => Effect.succeed(input.todos),
    }),
  )

  const agents = Layer.succeed(
    Agent.Service,
    Agent.Service.of({
      get: () => Effect.succeed(input.agent),
      list: () => Effect.succeed([input.agent]),
      defaultInfo: () => Effect.succeed(input.agent),
      defaultAgent: () => Effect.succeed(input.agent.name),
      generate: () => Effect.succeed({ identifier: "x", whenToUse: "", systemPrompt: "" }),
    }),
  )

  const background = Layer.succeed(
    BackgroundJob.Service,
    BackgroundJob.Service.of({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      start: () => Effect.succeed(job()),
      extend: () => Effect.succeed(false),
      wait: () => Effect.succeed({ info: job(), timedOut: false }),
      waitForPromotion: () => Effect.succeed(job()),
      promote: () => Effect.succeed(undefined),
      cancel: () => Effect.succeed(undefined),
    }),
  )

  const runState = Layer.succeed(
    SessionRunState.Service,
    SessionRunState.Service.of({
      assertNotBusy: () => Effect.succeed(undefined),
      cancel: () => Effect.void,
      ensureRunning: (_id, _onInterrupt, work) => work,
      startShell: (_id, onInterrupt, work) =>
        Effect.succeed({ info: undefined, parts: [] } as unknown as SessionV1.WithParts),
    }),
  )

  return { sessions, todos, agents, background, runState }
}

const buildLayer = (input: { todos: Todo.Info[]; agent: Agent.Info; parentID?: SessionID }) => {
  const { calls, layer: promptMock } = makeSessionPromptMock()
  const mocks = makeMocks(input)
  const root = LayerNode.compile(LayerNode.group([TodoContinuation.node, EventV2Bridge.node]), [
    [EventV2Bridge.node, makeEventBridge()],
    [Session.node, mocks.sessions],
    [Todo.node, mocks.todos],
    [Agent.node, mocks.agents],
    [BackgroundJob.node, mocks.background],
    [SessionPrompt.node, promptMock],
    [SessionRunState.node, mocks.runState],
  ])
  return { calls, root }
}

const integration = buildLayer({ todos: [doneTodo("a"), openTodo("b")], agent: editableAgent })
const it = testEffect(integration.root)

describe("todo-continuation enforcer", () => {
  it.live("injects a synthetic continue prompt on idle with open todos", () =>
    Effect.gen(function* () {
      integration.calls.length = 0
      const events = yield* EventV2Bridge.Service
      yield* events.publish(SessionStatusEvent.Idle, { sessionID })
      const call = yield* pollWithTimeout(
        Effect.sync(() => integration.calls.find((c) => c.sessionID === sessionID)),
        "no continue prompt injected",
      )
      expect(call.agent).toBe("build")
      const text = (call.parts[0] as { text?: string }).text ?? ""
      expect(text).toContain("[Status: 1/2 completed]")
      expect(text).toContain("open task")
      expect(text).toContain("b")
    }),
  )

  it.live("injects once per idle and keeps bouldering while todos stay open", () =>
    Effect.gen(function* () {
      integration.calls.length = 0
      const events = yield* EventV2Bridge.Service
      yield* events.publish(SessionStatusEvent.Idle, { sessionID })
      yield* pollWithTimeout(
        Effect.sync(() => (integration.calls.length >= 1 ? (true as const) : undefined)),
        "first continuation never injected",
      )
      yield* events.publish(SessionStatusEvent.Idle, { sessionID })
      yield* pollWithTimeout(
        Effect.sync(() => (integration.calls.length >= 2 ? (true as const) : undefined)),
        "second idle did not re-inject",
      )
      expect(integration.calls.length).toBe(2)
    }),
  )

  it.live("skips injection when the session was aborted within the cooldown", () =>
    Effect.gen(function* () {
      integration.calls.length = 0
      const events = yield* EventV2Bridge.Service
      // Abort lands first (processor publishes the error before the idle).
      yield* events.publish(SessionV1.Event.Error, {
        sessionID,
        error: new SessionV1.AbortedError({ message: "aborted" }).toObject(),
      })
      yield* events.publish(SessionStatusEvent.Idle, { sessionID })
      yield* Effect.sleep("50 millis")
      expect(integration.calls.length).toBe(0)
    }),
  )
})
