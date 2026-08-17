import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@newhorse/core/v1/session"
import { SessionProjector } from "@newhorse/core/session/projector"
import { ModelV2 } from "@newhorse/core/model"
import { ProviderV2 } from "@newhorse/core/provider"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, interruptedTurnClosers } from "../../src/session/repair"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const sessionID = SessionID.make("ses_repair_test")

const assistant = (input: {
  id: SessionV1.MessageID
  parentID: SessionV1.MessageID
  created: number
  completed?: number
  parts: SessionV1.Part[]
}): SessionV1.WithParts => ({
  info: {
    id: input.id,
    sessionID,
    role: "assistant",
    time: { created: input.created, ...(input.completed === undefined ? {} : { completed: input.completed }) },
    parentID: input.parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: input.parts,
})

const toolPart = (input: {
  id?: SessionV1.PartID
  messageID?: SessionV1.MessageID
  callID: string
  status: "pending" | "running" | "completed" | "error"
}): SessionV1.ToolPart => {
  const base = {
    id: input.id ?? PartID.ascending(),
    sessionID,
    messageID: input.messageID ?? MessageID.ascending(),
    type: "tool" as const,
    callID: input.callID,
    tool: "read",
  }
  const state: SessionV1.ToolState = (() => {
    switch (input.status) {
      case "pending":
        return { status: "pending", input: { path: "a.txt" }, raw: '{"path":"a.txt"}' }
      case "running":
        return { status: "running", input: { path: "a.txt" }, time: { start: 200 } }
      case "completed":
        return {
          status: "completed",
          input: { path: "a.txt" },
          output: "done",
          title: "read",
          metadata: {},
          time: { start: 200, end: 300 },
        }
      case "error":
        return {
          status: "error",
          input: { path: "a.txt" },
          error: "Tool execution aborted",
          metadata: { interrupted: true },
          time: { start: 200, end: 300 },
        }
    }
  })()
  return { ...base, state }
}

describe("SessionRepair interruptedTurnClosers", () => {
  test("returns nothing when the tail is a user message", () => {
    const user: SessionV1.WithParts = {
      info: {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: 100 },
        agent: "user",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      },
      parts: [],
    }
    expect(interruptedTurnClosers([user])).toBeUndefined()
  })

  test("returns nothing when the tail assistant turn is closed", () => {
    const tail = assistant({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      created: 100,
      completed: 400,
      parts: [toolPart({ callID: "call-1", status: "completed" })],
    })
    expect(interruptedTurnClosers([tail])).toBeUndefined()
  })

  test("closes an unclosed tail assistant with no tool calls", () => {
    const tail = assistant({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      created: 100,
      parts: [],
    })
    const closure = interruptedTurnClosers([tail])
    expect(closure).toMatchObject({ assistantMessageID: tail.info.id, completed: 100, tools: [] })
  })

  test("marks a running tool as TOOL_OUTCOME_UNKNOWN and closes the turn", () => {
    const tail = assistant({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      created: 100,
      parts: [toolPart({ callID: "call-1", status: "running" })],
    })
    const closure = interruptedTurnClosers([tail])
    expect(closure?.tools).toEqual([
      {
        partID: tail.parts[0]!.id,
        code: TOOL_OUTCOME_UNKNOWN,
        message: expect.stringContaining("read-only or idempotent"),
        start: 200,
        end: 200,
      },
    ])
    expect(closure?.completed).toBe(200)
  })

  test("marks a pending tool as TOOL_NOT_STARTED", () => {
    const tail = assistant({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      created: 100,
      parts: [toolPart({ callID: "call-1", status: "pending" })],
    })
    const closure = interruptedTurnClosers([tail])
    expect(closure?.tools).toEqual([
      {
        partID: tail.parts[0]!.id,
        code: TOOL_NOT_STARTED,
        message: expect.stringContaining("interrupted before it started"),
        start: 100,
        end: 100,
      },
    ])
  })

  test("treats a provider-executed pending hosted call as outcome unknown", () => {
    const part = toolPart({ callID: "call-1", status: "pending" })
    part.metadata = { providerExecuted: true }
    const tail = assistant({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      created: 100,
      parts: [part],
    })
    const closure = interruptedTurnClosers([tail])
    expect(closure?.tools[0]).toMatchObject({
      code: TOOL_OUTCOME_UNKNOWN,
      message: expect.stringContaining("read-only or idempotent"),
    })
  })

  test("closes an unclosed tail whose tools are already terminal", () => {
    const tail = assistant({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      created: 100,
      parts: [toolPart({ callID: "call-1", status: "completed" }), toolPart({ callID: "call-2", status: "error" })],
    })
    const closure = interruptedTurnClosers([tail])
    expect(closure).toMatchObject({ assistantMessageID: tail.info.id, completed: 300, tools: [] })
  })

  test("reuses the last recorded part time as the synthetic completion timestamp", () => {
    const tail = assistant({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      created: 100,
      parts: [
        {
          id: PartID.ascending(),
          sessionID,
          messageID: MessageID.ascending(),
          type: "text",
          text: "partial",
          time: { start: 150, end: 250 },
        },
        toolPart({ callID: "call-1", status: "running" }),
      ],
    })
    const closure = interruptedTurnClosers([tail])
    expect(closure?.completed).toBe(250)
  })
})

describe("SessionRepair apply on the load path", () => {
  it.instance("closes a crashed tail turn when messages are loaded", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const info = yield* sessions.create({})
      const userID = MessageID.ascending()
      const assistantID = MessageID.ascending()
      const partID = PartID.ascending()
      const now = Date.now()
      yield* sessions.updateMessage({
        id: userID,
        sessionID: info.id,
        role: "user",
        time: { created: now },
        agent: "user",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        sessionID: info.id,
        role: "assistant",
        time: { created: now + 1 },
        parentID: userID,
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "build",
        agent: "build",
        path: { cwd: info.directory, root: info.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: info.id,
        messageID: assistantID,
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: { status: "pending", input: { path: "a.txt" }, raw: '{"path":"a.txt"}' },
      })

      const loaded = yield* sessions.messages({ sessionID: info.id })
      const tail = loaded.at(-1)
      expect(tail?.info).toMatchObject({ id: assistantID, role: "assistant" })
      expect((tail?.info as SessionV1.Assistant).time.completed).toEqual(expect.any(Number))
      expect(tail?.parts).toHaveLength(1)
      expect((tail?.parts[0] as SessionV1.ToolPart).state).toMatchObject({
        status: "error",
        metadata: { interrupted: true, recovery: TOOL_NOT_STARTED },
      })
      expect((tail?.parts[0] as SessionV1.ToolPart).state as SessionV1.ToolStateError).toMatchObject({
        error: expect.stringContaining("interrupted before it started"),
      })

      const reloaded = yield* sessions.messages({ sessionID: info.id })
      const tailAgain = reloaded.at(-1)
      expect((tailAgain?.parts[0] as SessionV1.ToolPart).state.status).toBe("error")
    }),
  )

  it.instance("repair is a no-op for a closed tail", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const info = yield* sessions.create({})
      const userID = MessageID.ascending()
      const assistantID = MessageID.ascending()
      const now = Date.now()
      yield* sessions.updateMessage({
        id: userID,
        sessionID: info.id,
        role: "user",
        time: { created: now },
        agent: "user",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        sessionID: info.id,
        role: "assistant",
        time: { created: now + 1, completed: now + 2 },
        parentID: userID,
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "build",
        agent: "build",
        path: { cwd: info.directory, root: info.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const loaded = yield* sessions.messages({ sessionID: info.id })
      expect((loaded.at(-1)?.info as SessionV1.Assistant).time.completed).toBe(now + 2)
    }),
  )
})
