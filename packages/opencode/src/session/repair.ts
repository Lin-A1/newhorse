export * as SessionRepair from "./repair"

import { Effect } from "effect"
import { Database } from "@newhorse/core/database/database"
import { SessionV1 } from "@newhorse/core/v1/session"
import { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = "TOOL_NOT_STARTED"

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN"
export type RecoveryCode = typeof TOOL_NOT_STARTED | typeof TOOL_OUTCOME_UNKNOWN

const NOT_STARTED_TEXT = "The tool call was interrupted before it started. Retry it if it is still needed."
const OUTCOME_UNKNOWN_TEXT =
  "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly."

export interface ToolClosure {
  readonly partID: SessionV1.PartID
  readonly code: RecoveryCode
  readonly message: string
  readonly start: number
  readonly end: number
}

export interface InterruptedTurnClosure {
  readonly assistantMessageID: SessionV1.MessageID
  readonly completed: number
  readonly tools: readonly ToolClosure[]
}

type Sessions = {
  readonly updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
}

/**
 * Return the deterministic closure of an interrupted tail turn. The tail
 * assistant message is closed with a synthetic completion timestamp that reuses
 * the last recorded part time, and every dangling tool call is given an error
 * result whose message guides the model not to retry blindly. A closed tail
 * with no dangling calls returns nothing.
 *
 * @param messages - the loaded durable message log to scan.
 * @returns the closure to apply to the tail turn, or nothing when it is already closed.
 */
export function interruptedTurnClosers(messages: readonly SessionV1.WithParts[]): InterruptedTurnClosure | undefined {
  const tail = messages.at(-1)
  if (!tail || tail.info.role !== "assistant") return undefined
  const info = tail.info
  const unclosed = info.time.completed === undefined
  const completed = lastRecordedTime(info, tail.parts)
  const tools: ToolClosure[] = []
  for (const part of tail.parts) {
    if (part.type !== "tool") continue
    const state = part.state
    if (state.status === "completed" || state.status === "error") continue
    // A hosted tool call records no local execution state, so its provider-executed
    // marker is the only durable signal that the call actually started.
    const started = state.status === "running" || part.metadata?.providerExecuted === true
    tools.push({
      partID: part.id,
      code: started ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED,
      message: started ? OUTCOME_UNKNOWN_TEXT : NOT_STARTED_TEXT,
      start: state.status === "running" ? state.time.start : completed,
      end: completed,
    })
  }
  if (!unclosed && tools.length === 0) return undefined
  return { assistantMessageID: info.id, completed, tools }
}

/** Apply an interrupted-turn closure to the tail message of the loaded log. */
export const apply = Effect.fn("SessionRepair.apply")(function* (
  sessions: Sessions,
  messages: readonly SessionV1.WithParts[],
) {
  const closure = interruptedTurnClosers(messages)
  if (!closure) return
  const tail = messages.find((message) => message.info.id === closure.assistantMessageID)
  if (!tail) return
  const info = tail.info
  info.time = { ...info.time, completed: closure.completed }
  yield* sessions.updateMessage(info)
  for (const tool of closure.tools) {
    const part = tail.parts.find((item): item is SessionV1.ToolPart => item.id === tool.partID)
    if (!part) continue
    part.state = {
      status: "error",
      input: part.state.input,
      error: tool.message,
      metadata: { interrupted: true, recovery: tool.code },
      time: { start: tool.start, end: tool.end },
    }
    yield* sessions.updatePart(part)
  }
  yield* Effect.logInfo("repaired interrupted turn", {
    "session.id": info.sessionID,
    messageID: info.id,
    tools: closure.tools.length,
  })
})

/** Load the tail message of a session and close it when the last turn was interrupted. */
export const repair = Effect.fn("SessionRepair.repair")(function* (
  sessions: Sessions,
  db: Database.Interface["db"],
  sessionID: SessionID,
) {
  const { items } = yield* MessageV2.page({ sessionID, limit: 1 }).pipe(
    Effect.provideService(Database.Service, { db }),
  )
  yield* apply(sessions, items)
})

function lastRecordedTime(info: SessionV1.Assistant, parts: readonly SessionV1.Part[]): number {
  let latest = info.time.created
  for (const part of parts) {
    const time = recordedTime(part)
    if (time !== undefined) latest = Math.max(latest, time)
  }
  return latest
}

function recordedTime(part: SessionV1.Part): number | undefined {
  if (part.type === "tool") {
    const state = part.state
    if (state.status === "pending") return undefined
    const time = state.time as { start: number; end?: number }
    return time.end ?? time.start
  }
  const time = (part as { time?: Record<string, unknown> }).time
  if (typeof time?.end === "number") return time.end
  if (typeof time?.start === "number") return time.start
  return undefined
}
