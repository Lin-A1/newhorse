export * as SessionInvariant from "./invariant"

import { and, asc, eq, inArray } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Durable } from "@newhorse/schema/durable-event-manifest"
import { Event } from "@newhorse/schema/event"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

const sessionDurableTypes = Array.from(Event.durable(SessionEvent.DurableDefinitions).keys())

export class InvariantViolationError extends Schema.TaggedErrorClass<InvariantViolationError>()(
  "SessionInvariant.Violation",
  {
    sessionID: SessionSchema.ID,
    seq: Schema.Int,
    type: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Session ${this.sessionID} event ${this.type} at seq ${this.seq} violates session invariants: ${this.detail}`
  }
}

export type InvariantFailure = (message: string) => never

type ToolScopedEvent = {
  readonly type: string
  readonly data: { readonly assistantMessageID: SessionMessage.ID; readonly callID: string }
}

/**
 * Relational state of one committed session aggregate. A step (assistant turn)
 * opens on `step.started` and closes on `step.ended`/`step.failed` or
 * implicitly on the next `step.started`; a tool call is pending from
 * `tool.input.started` until its `tool.success`/`tool.failed` settlement.
 */
export interface SessionTrace {
  readonly lastSeq: number
  readonly openStep: string | null
  readonly startedSteps: Set<string>
  readonly settledSteps: Set<string>
  readonly pendingCalls: Map<string, Set<string>>
}

export const freshTrace = (): SessionTrace => ({
  lastSeq: -1,
  openStep: null,
  startedSteps: new Set(),
  settledSteps: new Set(),
  pendingCalls: new Map(),
})

/** One accepted event's deferred mutation of a committed session trace. */
export interface SessionTraceTransition {
  readonly lastSeq: number
  readonly openStep: string | null
  readonly started: string | null
  readonly settled: string | null
  readonly pending: { readonly kind: "add" | "delete"; readonly messageID: string; readonly callID: string } | null
}

const requireOpenStep = (trace: SessionTrace, event: ToolScopedEvent, fail: InvariantFailure): void => {
  const messageID = String(event.data.assistantMessageID)
  if (trace.openStep !== messageID) {
    fail(`${event.type} for ${messageID} but open step is ${trace.openStep ?? "none"}`)
  }
}

const requirePendingCall = (trace: SessionTrace, event: ToolScopedEvent, fail: InvariantFailure): void => {
  const messageID = String(event.data.assistantMessageID)
  if (!trace.pendingCalls.get(messageID)?.has(event.data.callID)) {
    fail(`${event.type} for ${event.data.callID} with no prior tool.input.started in step ${messageID}`)
  }
}

/** Validate one candidate event without mutating the committed trace. */
export function validateEvent(
  trace: SessionTrace,
  event: SessionEvent.DurableEvent,
  fail: InvariantFailure,
): SessionTraceTransition {
  const seq = event.durable?.seq
  if (seq === undefined) {
    return { lastSeq: trace.lastSeq, openStep: trace.openStep, started: null, settled: null, pending: null }
  }
  if (seq <= trace.lastSeq) {
    fail(`seq must strictly increase: saw ${seq} after ${trace.lastSeq}`)
  }
  let openStep = trace.openStep
  let started: string | null = null
  let settled: string | null = null
  let pending: SessionTraceTransition["pending"] = null

  switch (event.type) {
    case "session.next.step.started": {
      const messageID = String(event.data.assistantMessageID)
      if (trace.startedSteps.has(messageID)) {
        fail(`step.started for ${messageID} which was already started`)
      }
      started = messageID
      openStep = messageID
      break
    }
    case "session.next.step.ended":
    case "session.next.step.failed": {
      const messageID = String(event.data.assistantMessageID)
      if (trace.settledSteps.has(messageID)) {
        fail(`step ${messageID} is already settled`)
      }
      if (trace.openStep === messageID) openStep = null
      settled = messageID
      break
    }
    case "session.next.tool.input.started": {
      requireOpenStep(trace, event, fail)
      if (trace.pendingCalls.get(String(event.data.assistantMessageID))?.has(event.data.callID)) {
        fail(`tool.input.started for ${event.data.callID} which is already pending`)
      }
      pending = { kind: "add", messageID: String(event.data.assistantMessageID), callID: event.data.callID }
      break
    }
    case "session.next.tool.input.ended":
    case "session.next.tool.called":
    case "session.next.tool.progress": {
      requireOpenStep(trace, event, fail)
      requirePendingCall(trace, event, fail)
      break
    }
    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const messageID = String(event.data.assistantMessageID)
      if (!trace.pendingCalls.get(messageID)?.has(event.data.callID)) {
        fail(`tool settlement for ${event.data.callID} with no prior tool.input.started in step ${messageID}`)
      }
      pending = { kind: "delete", messageID, callID: event.data.callID }
      break
    }
    default:
      break
  }
  return { lastSeq: seq, openStep, started, settled, pending }
}

/** Apply one already-validated transition after its event commits. */
export function applyTransition(trace: SessionTrace, transition: SessionTraceTransition): void {
  Object.assign(trace, { lastSeq: transition.lastSeq, openStep: transition.openStep })
  if (transition.started !== null) trace.startedSteps.add(transition.started)
  if (transition.settled !== null) trace.settledSteps.add(transition.settled)
  if (transition.pending === null) return
  const calls = trace.pendingCalls.get(transition.pending.messageID) ?? new Set<string>()
  if (transition.pending.kind === "add") calls.add(transition.pending.callID)
  else calls.delete(transition.pending.callID)
  trace.pendingCalls.set(transition.pending.messageID, calls)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const traces = new Map<string, SessionTrace>()
    const stagedTransitions = new Map<
      EventV2.ID,
      { readonly sessionID: SessionSchema.ID; readonly transition: SessionTraceTransition }
    >()

    const failFor = (event: SessionEvent.DurableEvent): InvariantFailure => (message) => {
      throw new InvariantViolationError({
        sessionID: event.data.sessionID,
        seq: event.durable?.seq ?? 0,
        type: event.type,
        detail: message,
      })
    }

    const seed = Effect.fn("SessionInvariant.seed")(function* (sessionID: SessionSchema.ID) {
      const trace = freshTrace()
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, sessionDurableTypes)))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const decode = Schema.decodeUnknownSync(SessionEvent.Durable)
      for (const row of rows) {
        const definition = Durable.get(row.type)
        if (definition?.durable === undefined) continue
        const event = decode({
          id: row.id,
          type: definition.type,
          durable: { aggregateID: row.aggregate_id, seq: row.seq, version: definition.durable.version },
          data: row.data,
        })
        applyTransition(trace, validateEvent(trace, event, failFor(event)))
      }
      return trace
    })

    const traceFor = Effect.fn("SessionInvariant.traceFor")(function* (sessionID: SessionSchema.ID) {
      const existing = traces.get(sessionID)
      if (existing) return existing
      const trace = yield* seed(sessionID)
      traces.set(sessionID, trace)
      return trace
    })

    const validate = Effect.fnUntraced(function* (event: EventV2.Payload) {
      const durable = event as unknown as SessionEvent.DurableEvent
      const sessionID = durable.data.sessionID
      let trace = yield* traceFor(sessionID)
      let transition: SessionTraceTransition
      try {
        transition = validateEvent(trace, durable, failFor(durable))
      } catch (cause) {
        // A stale in-memory trace (replayed without publication, rolled-back
        // commit) can reject a legitimate event. Re-seed from the committed
        // log once before treating the rejection as a violation.
        if (!(cause instanceof InvariantViolationError)) throw cause
        trace = yield* seed(sessionID)
        traces.set(sessionID, trace)
        transition = validateEvent(trace, durable, failFor(durable))
      }
      stagedTransitions.set(event.id, { sessionID, transition })
    })

    for (const definition of SessionEvent.DurableDefinitions) {
      yield* events.project(definition, validate as EventV2.Subscriber)
    }

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const staged = stagedTransitions.get(event.id)
        if (staged === undefined) return
        if (event.durable === undefined || event.durable.aggregateID !== staged.sessionID) return
        stagedTransitions.delete(event.id)
        const trace = traces.get(staged.sessionID)
        if (trace === undefined) return
        applyTransition(trace, staged.transition)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
  }),
)

export const node = makeGlobalNode({ name: "session-invariant", layer, deps: [EventV2.node, Database.node] })
