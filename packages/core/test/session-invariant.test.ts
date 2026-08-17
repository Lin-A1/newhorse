import { describe, expect, test } from "bun:test"
import { Cause, DateTime, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { EventV2 } from "@newhorse/core/event"
import { EventTable } from "@newhorse/core/event/sql"
import { Database } from "@newhorse/core/database/database"
import { ModelV2 } from "@newhorse/core/model"
import { ProviderV2 } from "@newhorse/core/provider"
import { SessionV2 } from "@newhorse/core/session"
import { SessionEvent } from "@newhorse/core/session/event"
import { SessionMessage } from "@newhorse/core/session/message"
import {
  InvariantViolationError,
  SessionInvariant,
  applyTransition,
  freshTrace,
  validateEvent,
  type SessionTrace,
} from "@newhorse/core/session/invariant"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_invariant_test")
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const mid = (n: number) => SessionMessage.ID.make(`msg_${n}`)
const decode = (input: Record<string, unknown>) => Schema.decodeUnknownSync(SessionEvent.Durable)(input)

const event = (type: string, seq: number, data: Record<string, unknown>) =>
  decode({ id: EventV2.ID.create(), type, durable: { aggregateID: sessionID, seq, version: 1 }, data })

const stepStarted = (seq: number, messageID: SessionMessage.ID) =>
  event("session.next.step.started", seq, {
    sessionID,
    assistantMessageID: messageID,
    timestamp: seq,
    agent: "build",
    model,
  })
const stepEnded = (seq: number, messageID: SessionMessage.ID) =>
  event("session.next.step.ended", seq, {
    sessionID,
    assistantMessageID: messageID,
    timestamp: seq,
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
const toolInputStarted = (seq: number, messageID: SessionMessage.ID, callID: string) =>
  event("session.next.tool.input.started", seq, {
    sessionID,
    assistantMessageID: messageID,
    callID,
    name: "echo",
    timestamp: seq,
  })
const toolCalled = (seq: number, messageID: SessionMessage.ID, callID: string) =>
  event("session.next.tool.called", seq, {
    sessionID,
    assistantMessageID: messageID,
    callID,
    tool: "echo",
    input: { text: "hi" },
    provider: { executed: false },
    timestamp: seq,
  })
const toolSuccess = (seq: number, messageID: SessionMessage.ID, callID: string) =>
  event("session.next.tool.success", seq, {
    sessionID,
    assistantMessageID: messageID,
    callID,
    structured: {},
    content: [],
    provider: { executed: false },
    timestamp: seq,
  })
const toolFailed = (seq: number, messageID: SessionMessage.ID, callID: string) =>
  event("session.next.tool.failed", seq, {
    sessionID,
    assistantMessageID: messageID,
    callID,
    error: { type: "unknown", message: "boom" },
    provider: { executed: false },
    timestamp: seq,
  })

const fail = (message: string): never => {
  throw new Error(message)
}
const replay = (trace: SessionTrace, events: readonly ReturnType<typeof event>[]) => {
  for (const item of events) {
    applyTransition(trace, validateEvent(trace, item, fail))
  }
  return trace
}
const violation = (fn: () => void) => expect(fn).toThrow(/seq must|already|no prior|open step/)

describe("SessionInvariant validateEvent", () => {
  test("accepts a balanced step with tool settlement", () => {
    replay(freshTrace(), [
      stepStarted(1, mid(1)),
      toolInputStarted(2, mid(1), "call-1"),
      toolCalled(3, mid(1), "call-1"),
      toolSuccess(4, mid(1), "call-1"),
      stepEnded(5, mid(1)),
    ])
  })

  test("accepts an interrupted step settled by the next step.started", () => {
    replay(freshTrace(), [
      stepStarted(1, mid(1)),
      toolInputStarted(2, mid(1), "call-1"),
      toolCalled(3, mid(1), "call-1"),
      toolFailed(4, mid(1), "call-1"),
      stepStarted(5, mid(2)),
      stepEnded(6, mid(2)),
    ])
  })

  test("rejects a non-increasing seq", () => {
    const trace = freshTrace()
    applyTransition(trace, validateEvent(trace, stepStarted(1, mid(1)), fail))
    violation(() => validateEvent(trace, stepStarted(1, mid(2)), fail))
  })

  test("rejects a step.started for an already started assistant message", () => {
    const trace = freshTrace()
    replay(trace, [stepStarted(1, mid(1))])
    violation(() => validateEvent(trace, stepStarted(2, mid(1)), fail))
  })

  test("rejects a duplicate step settlement", () => {
    const trace = freshTrace()
    replay(trace, [stepStarted(1, mid(1)), stepEnded(2, mid(1))])
    violation(() => validateEvent(trace, stepEnded(3, mid(1)), fail))
  })

  test("rejects a tool result without a prior tool.input.started", () => {
    const trace = freshTrace()
    replay(trace, [stepStarted(1, mid(1))])
    violation(() => validateEvent(trace, toolSuccess(2, mid(1), "call-1"), fail))
  })

  test("rejects a duplicate tool settlement", () => {
    const trace = freshTrace()
    replay(trace, [
      stepStarted(1, mid(1)),
      toolInputStarted(2, mid(1), "call-1"),
      toolSuccess(3, mid(1), "call-1"),
    ])
    violation(() => validateEvent(trace, toolFailed(4, mid(1), "call-1"), fail))
  })

  test("rejects a tool settlement for a call registered in a different step", () => {
    const trace = freshTrace()
    replay(trace, [
      stepStarted(1, mid(1)),
      toolInputStarted(2, mid(1), "call-1"),
      stepStarted(3, mid(2)),
    ])
    violation(() => validateEvent(trace, toolSuccess(4, mid(2), "call-1"), fail))
  })

  test("allows a tool settlement for a call of a closed step", () => {
    replay(freshTrace(), [
      stepStarted(1, mid(1)),
      toolInputStarted(2, mid(1), "call-1"),
      stepStarted(3, mid(2)),
      toolSuccess(4, mid(1), "call-1"),
      stepEnded(5, mid(2)),
    ])
  })

  test("rejects a tool call that starts outside the open step", () => {
    const trace = freshTrace()
    replay(trace, [stepStarted(1, mid(1))])
    violation(() => validateEvent(trace, toolInputStarted(2, mid(2), "call-1"), fail))
  })

  test("rejects tool stream events for a call that never started", () => {
    const trace = freshTrace()
    replay(trace, [stepStarted(1, mid(1))])
    violation(() => validateEvent(trace, toolCalled(2, mid(1), "call-1"), fail))
  })

  test("allows tool settlement for the crashed open step before the next step", () => {
    replay(freshTrace(), [
      stepStarted(1, mid(1)),
      toolInputStarted(2, mid(1), "call-1"),
      toolCalled(3, mid(1), "call-1"),
      toolFailed(4, mid(1), "call-1"),
    ])
  })

  test("ignores non-step events while advancing the sequence", () => {
    const trace = freshTrace()
    replay(trace, [
      event("session.next.prompted", 1, {
        sessionID,
        messageID: mid(1),
        prompt: { text: "hello", files: [], agents: [] },
        delivery: "steer",
        timestamp: 1,
      }),
      stepStarted(2, mid(1)),
    ])
    expect(trace.lastSeq).toBe(2)
  })
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionInvariant.node])))

const appendSessionID = SessionV2.ID.make("ses_invariant_append")

const publishStepStarted = (events: EventV2.Interface, messageID: SessionMessage.ID) =>
  events.publish(SessionEvent.Step.Started, {
    sessionID: appendSessionID,
    assistantMessageID: messageID,
    timestamp: DateTime.makeUnsafe(1),
    agent: "build",
    model,
  })
const publishStepEnded = (events: EventV2.Interface, messageID: SessionMessage.ID) =>
  events.publish(SessionEvent.Step.Ended, {
    sessionID: appendSessionID,
    assistantMessageID: messageID,
    timestamp: DateTime.makeUnsafe(1),
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
const publishToolFailed = (events: EventV2.Interface, messageID: SessionMessage.ID, callID: string) =>
  events.publish(SessionEvent.Tool.Failed, {
    sessionID: appendSessionID,
    assistantMessageID: messageID,
    callID,
    timestamp: DateTime.makeUnsafe(1),
    error: { type: "unknown", message: "boom" },
    provider: { executed: false },
  })

describe("SessionInvariant append path", () => {
  it.effect("commits a valid step and tool sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const messageID = mid(9)
      const callID = "call-ok"
      yield* publishStepStarted(events, messageID)
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: appendSessionID,
        assistantMessageID: messageID,
        callID,
        name: "echo",
        timestamp: DateTime.makeUnsafe(1),
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: appendSessionID,
        assistantMessageID: messageID,
        callID,
        tool: "echo",
        input: {},
        provider: { executed: false },
        timestamp: DateTime.makeUnsafe(1),
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: appendSessionID,
        assistantMessageID: messageID,
        callID,
        structured: {},
        content: [],
        provider: { executed: false },
        timestamp: DateTime.makeUnsafe(1),
      })
      yield* publishStepEnded(events, messageID)
      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, appendSessionID))
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).toEqual([
        "session.next.step.started.1",
        "session.next.tool.input.started.1",
        "session.next.tool.called.1",
        "session.next.tool.success.1",
        "session.next.step.ended.2",
      ])
    }),
  )

  it.effect("rejects a tool result that never started and commits nothing", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const exit = yield* publishToolFailed(events, mid(10), "call-ghost").pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("SessionInvariant.Violation")
      const count = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, appendSessionID))
        .all()
        .pipe(Effect.orDie)
      expect(count).toHaveLength(0)
    }),
  )

  it.effect("rejects a duplicate step settlement", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const messageID = mid(11)
      yield* publishStepStarted(events, messageID)
      yield* publishStepEnded(events, messageID)
      const exit = yield* publishStepEnded(events, messageID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("SessionInvariant.Violation")
    }),
  )

  it.effect("rejects a step started twice for the same assistant message", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const messageID = mid(12)
      yield* publishStepStarted(events, messageID)
      const exit = yield* publishStepStarted(events, messageID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("SessionInvariant.Violation")
    }),
  )
})

