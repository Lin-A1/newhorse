/**
 * Event-sourced storage shape and the canonical session event vocabulary.
 *
 * The durable shape is `(aggregate_id, seq, type, data)` — an append-only log.
 * This is deliberately an OPEN contract: `type` is a string and `data` is
 * untagged, so new facts about any aggregate can be appended without touching
 * the shape. Durable facts must be reconstructable from the log, never from
 * live memory.
 *
 * We distinguish two layers:
 *   - `StoredEvent` — the durable, OPEN append log. Never needs to change.
 *   - `SessionEvent` — the live subscription view. This is an INITIAL set and
 *     WILL grow with the feature set (tool settlement, compaction, spawn). It
 *     is not a locked contract; do not exhaustively match on it everywhere.
 */
import type { SessionMessage } from "./session"

export type UnknownRecord = Record<string, unknown>

/** Discriminates which aggregate owns an event (session, agent, task, ...). */
export type AggregateType = "session"

export interface StoredEvent<T = UnknownRecord> {
  readonly aggregate: AggregateType
  readonly aggregate_id: string
  readonly seq: number
  readonly type: string
  readonly data: T
}

export type Delivery = "steer" | "queue"

/**
 * Live subscription event. The union is open-ended and grows with features;
 * treat it as a namespace of string-tagged payloads, not an exhaustive set.
 */
export interface SessionEventBase<T extends string, P extends UnknownRecord> {
  readonly type: T
  readonly data: P
}

export type SessionEvent =
  | SessionEventBase<"Session.Created", { readonly id: string; readonly location: string; readonly createdAt: number }>
  | SessionEventBase<"Session.PromptAdmitted", { readonly id: string; readonly sessionId: string; readonly prompt: string; readonly delivery: Delivery; readonly admittedSeq: number }>
  | SessionEventBase<"Session.Prompted", { readonly id: string; readonly sessionId: string; readonly prompt: string; readonly delivery: Delivery; readonly promotedSeq: number }>
  | SessionEventBase<"Session.MessageAppended", { readonly sessionId: string; readonly message: SessionMessage }>
  | SessionEventBase<"Session.ToolSettled", { readonly sessionId: string; readonly assistantMessageId: string; readonly callId: string; readonly name: string; readonly isError?: boolean }>
  | SessionEventBase<"Session.StepEnded", { readonly sessionId: string; readonly step: number; readonly finish: string }>
  | SessionEventBase<"Session.Interrupted", { readonly sessionId: string }>

/** Convenience: type guard narrowing one live event by its `type` tag. */
export function isSessionEvent<E extends SessionEvent["type"]>(
  event: SessionEvent,
  type: E,
): event is Extract<SessionEvent, { type: E }> {
  return event.type === type
}
