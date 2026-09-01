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
import type { LLMUsage } from "./llm"

export type UnknownRecord = Record<string, unknown>

/** Discriminates which aggregate owns an event (session, audit, dag, ...). */
export type AggregateType = "session" | "audit" | "dag"

export interface StoredEvent<T = UnknownRecord> {
  readonly aggregate: AggregateType
  readonly aggregate_id: string
  readonly seq: number
  readonly type: string
  readonly data: T
  /** Store-level write time (ms). Present for events written after the
   *  created_at column shipped; legacy rows carry no timestamp. */
  readonly ts?: number
}

export type Delivery = "steer" | "queue"

/** Who authored a prompt: a human (user), the butler, or a spawned agent. */
export type Principal = "user" | "butler" | "parent"

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
  | SessionEventBase<"Session.PromptAdmitted", { readonly id: string; readonly sessionId: string; readonly prompt: string; readonly delivery: Delivery; readonly principal: Principal; readonly admittedSeq: number }>
  | SessionEventBase<"Session.Prompted", { readonly id: string; readonly sessionId: string; readonly prompt: string; readonly delivery: Delivery; readonly principal: Principal; readonly promotedSeq: number }>
  | SessionEventBase<"Session.MessageAppended", { readonly sessionId: string; readonly message: SessionMessage }>
  | SessionEventBase<"Session.StepEnded", { readonly sessionId: string; readonly step: number; readonly finish: string; readonly usage?: LLMUsage }>
  | SessionEventBase<"Session.ModelCalled", { readonly sessionId: string; readonly source: "turn" | "compaction" | "extraction"; readonly model: string; readonly durationMs: number; readonly finish?: string; readonly usage?: unknown; readonly promptChars: number; readonly outputChars: number; readonly error?: string; readonly ts?: number }>
  | SessionEventBase<"Session.Interrupted", { readonly sessionId: string }>
  | SessionEventBase<"Session.Spawned", { readonly sessionId: string; readonly parentId: string }>
  | SessionEventBase<"Session.Settled", { readonly sessionId: string; readonly finish: string; readonly needsContinuation: boolean }>
  | SessionEventBase<"Session.MemoryStored", { readonly sessionId: string; readonly memoryId: string; readonly content: string; readonly ts: number }>
  | SessionEventBase<"Session.Compacted", { readonly sessionId: string; readonly boundarySeq: number; readonly summary: string; readonly retainedFrom: number }>
  | SessionEventBase<"Session.TodoUpdated", { readonly sessionId: string; readonly todos: ReadonlyArray<{ readonly content: string; readonly status: "pending" | "in_progress" | "completed" | "cancelled"; readonly activeForm?: string }> }>
  | SessionEventBase<"Session.PolicyChanged", { readonly sessionId: string; readonly from: string; readonly to: string; readonly by: "host" | "model-approved"; readonly ts: number }>
  | SessionEventBase<"Session.GoalUpdated", { readonly sessionId: string; readonly objective: string; readonly status: "active" | "paused" | "blocked" | "complete"; readonly tokenBudget?: number; readonly ts: number }>
  | SessionEventBase<"Session.TitleSet", { readonly sessionId: string; readonly title: string; readonly ts: number }>
  | SessionEventBase<"Session.Archived", { readonly sessionId: string; readonly archived: boolean; readonly ts: number }>
  | SessionEventBase<"Session.ButlerAction", { readonly sessionId: string; readonly actorKind: "user" | "butler" | "parent"; readonly actorId: string; readonly op: string; readonly targetSessionId?: string; readonly outcome: "allowed" | "denied"; readonly reason?: string; readonly ts: number }>
  | SessionEventBase<"Session.ExecDecision", { readonly sessionId: string; readonly kind: "command" | "path"; readonly action: string; readonly decision: "prompt" | "forbid"; readonly reason?: string; readonly requestId?: string; readonly ts: number }>

/** Convenience: type guard narrowing one live event by its `type` tag. */
export function isSessionEvent<E extends SessionEvent["type"]>(
  event: SessionEvent,
  type: E,
): event is Extract<SessionEvent, { type: E }> {
  return event.type === type
}
