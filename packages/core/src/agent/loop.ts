import type { LLMEvent, LLMRequest, SessionMessage, ContentPart, ToolCallPart } from "@newhorse/schema"
import type { TurnRuntime, Agent, Tool, ToolCall, ToolResult, ToolCtx, Initiator } from "./runner"
import { Session } from "../session/session"
import { toLlmMessages } from "../session/messages"
import { denyAllExecPolicy } from "./execpolicy"

/** Hard cap on steps per drain to guarantee termination. */
const MAX_STEPS = 50

export interface TurnResult {
  readonly needsContinuation: boolean
  readonly step: number
  readonly finish: "tool" | "stop" | "length" | "content-filter" | "interrupted" | "error"
}

/** A live loop event a transport can render incrementally. */
export type LoopEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly input: unknown }
  | { readonly type: "tool-result"; readonly name: string; readonly output: unknown; readonly isError?: boolean }
  | { readonly type: "step"; readonly step: number }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "done"; readonly step: number; readonly needsContinuation: boolean; readonly finish: string }

export interface RunOptions {
  readonly agent: Agent
  readonly sessionId: string
  /** Call a registered tool; throws on unknown tool. */
  readonly resolveTool: (name: string) => Tool | undefined
  /** Optional live-event sink for a shell to render streaming output. */
  readonly onEvent?: (event: LoopEvent) => void
  /** Optional cancellation: when aborted, the drain stops between steps. */
  readonly signal?: AbortSignal
  /** Trusted caller injected into tool ctx (M2b). Defaults to parent of sessionId. */
  readonly caller?: Initiator
  /** Extra tool-ctx fields to merge (e.g. registry/appendAudit for butler tools). */
  readonly toolCtx?: Omit<ToolCtx, "caller">
}

/**
 * Run one durable agent session to settlement: promote eligible input, take one
 * provider turn per step, execute tool calls, and settle until the model stops
 * requesting tools. Returns whether the drain still has pending work.
 *
 * Everything the model sees is derived from the log (see toLlmMessages) and
 * everything it produces is written back to the log first — "model-visible ⟺
 * logged".
 */
export async function runSession(runtime: TurnRuntime, opts: RunOptions): Promise<TurnResult> {
  let turns = 0
  let needsContinuation = true
  let lastStepEnded: "tool" | "stop" | "length" | "content-filter" | "error" = "tool"

  while (needsContinuation && turns < MAX_STEPS) {
    if (opts.signal?.aborted) {
      // Cancelled between steps: settle as interrupted rather than continuing.
      return cancelledResult(runtime, opts, turns)
    }
    turns += 1
    const session = await loadSession(runtime.events, opts.sessionId)
    const cutoff = await runtime.events.latestSeq(opts.sessionId)

    // Promote eligible steers (and one queued input) into model-visible history.
    // Their Prompted events become the user messages pushed this turn.
    const promotedSteers = await runtime.inbox.promoteSteers(opts.sessionId, cutoff)
    if (promotedSteers === 0) {
      const any = await runtime.inbox.hasPending(opts.sessionId, "queue")
      if (any) await runtime.inbox.promoteNextQueued(opts.sessionId)
    }

    // Re-derive visible history AFTER promotion so steers are in this turn.
    const projected = await loadSession(runtime.events, opts.sessionId)
    // Fail any in-flight tool that never settled (e.g. after a crash): a tool
    // call with no paired result must not be silently replayed, and this keeps
    // the next request well-formed rather than feeding a malformed history.
    await failInterruptedTools(runtime.events, opts.sessionId, projected)
    const refreshed = await loadSession(runtime.events, opts.sessionId)
    const messages = toLlmMessages(refreshed.snapshot().messages, opts.agent.model)
    if (messages.length === 0) {
      // Nothing promoted and no history yet — drain is done.
      break
    }

    const request: LLMRequest = {
      model: opts.agent.model,
      messages,
      tools: opts.agent.tools?.map(toSpec),
    }

    let turn: { needsContinuation: boolean; step: number; finish: "tool" | "stop" | "length" | "content-filter" | "error" }
    try {
      turn = await runTurn(runtime, opts, request, turns)
    } catch (e) {
      // A cancelled stream surfaces as either our SessionCancelled marker or the
      // llm transport's LlmCancelled; both mean "interrupt the run". We detect
      // by tag without importing the llm package (core must not depend on it).
      if (isCancelled(e)) return cancelledResult(runtime, opts, turns)
      throw e
    }
    needsContinuation = turn.needsContinuation
    lastStepEnded = turn.finish
  }

  const result: TurnResult = { needsContinuation: needsContinuation && lastStepEnded === "tool", step: turns, finish: lastStepEnded }
  opts.onEvent?.({ type: "done", step: result.step, needsContinuation: result.needsContinuation, finish: lastStepEnded })
  return result
}

/** Build an interrupted result and emit the live done event for a cancellation. */
async function cancelledResult(runtime: TurnRuntime, opts: RunOptions, turns: number): Promise<TurnResult> {
  await runtime.events.append(opts.sessionId, "Session.Interrupted", { sessionId: opts.sessionId })
  const result: TurnResult = { needsContinuation: false, step: turns, finish: "interrupted" }
  opts.onEvent?.({ type: "done", step: result.step, needsContinuation: false, finish: "interrupted" })
  return result
}

/** Detect a cancellation from the llm transport or a fetch abort
 * (AbortError/DOMException). Core cannot import the llm package, so the llm
 * transport's LlmCancelled is matched structurally by name/tag. */
function isCancelled(e: unknown): boolean {
  const err = e as { name?: string; _tag?: string; code?: number } | null
  if (!err) return false
  // llm transport's LlmCancelled.
  if (err.name === "LlmCancelled" || err._tag === "LlmCancelled") return true
  // A fetch that aborted before/at the request phase surfaces as AbortError.
  if (err.name === "AbortError") return true
  // DOM abort (some runtimes) surfaces as DOMException with code 20 (ABORT_ERR).
  if (typeof err.code === "number" && err.code === 20) return true
  return false
}

/**
 * One provider turn: stream the request, archive assistant text + tool calls,
 * execute tools, and settle. Returns whether another turn is required.
 */
async function runTurn(runtime: TurnRuntime, opts: RunOptions, request: LLMRequest, step: number): Promise<{ needsContinuation: boolean; step: number; finish: "tool" | "stop" | "length" | "content-filter" | "error"; usage?: unknown }> {
  const assistantId = crypto.randomUUID()
  const assistantParts: ContentPart[] = []

  let needsContinuation = false
  let finish: "tool" | "stop" | "length" | "content-filter" | "error" = "stop"
  let usage: unknown

  const stream = await runtime.llm.stream(request, opts.signal)
  try {
    for await (const event of stream) {
      switch (event.type) {
        case "text.delta": {
          opts.onEvent?.({ type: "text", text: event.text })
          const last = assistantParts[assistantParts.length - 1]
          if (last?.type === "text") assistantParts[assistantParts.length - 1] = { type: "text", text: last.text + event.text }
          else assistantParts.push({ type: "text", text: event.text })
          break
        }
        case "reasoning.delta": {
          opts.onEvent?.({ type: "reasoning", text: event.text })
          const last = assistantParts[assistantParts.length - 1]
          if (last?.type === "reasoning") assistantParts[assistantParts.length - 1] = { type: "reasoning", text: last.text + event.text }
          else assistantParts.push({ type: "reasoning", text: event.text })
          break
        }
        case "reasoning.ended": {
          // Merge the opaque provider payload (e.g. Anthropic signature) onto the
          // last reasoning part so a same-model continuation can round-trip it.
          const last = assistantParts[assistantParts.length - 1]
          if (last?.type === "reasoning") {
            assistantParts[assistantParts.length - 1] = { type: "reasoning", text: last.text, ...(event.payload ? { payload: event.payload } : {}) }
          } else {
            assistantParts.push({ type: "reasoning", text: event.text, ...(event.payload ? { payload: event.payload } : {}) })
          }
          break
        }
        case "tool-call": {
          // Normalize provider-encoded input (a JSON string from any protocol) into
          // a JS object at the single boundary — a tool always receives an object,
          // never an opaque string, so tools don't need to defensively parse. This
          // is the canonical contract upstream of tool.execute.
          const input = normalizeToolInput(event.input)
          opts.onEvent?.({ type: "tool", name: event.name, input })
          assistantParts.push({ type: "tool-call", id: event.id, name: event.name, input })
          break
        }
        case "step-finish":
          finish = event.finish
          usage = event.usage
          opts.onEvent?.({ type: "step", step })
          break
        case "provider-error":
          // A provider failure must never masquerade as a normal stop — shells and
          // smoke tests key off finish to decide success.
          finish = "error"
          needsContinuation = false
          opts.onEvent?.({ type: "error", code: event.code, message: event.message })
          break
      }
    }
  } catch (e) {
    // If the stream is aborted before completing, the parts we already buffered
    // were emitted live but not yet logged. Flush them so "model-visible ⟺
    // logged" holds even on a cancellation — the next resume must see the same
    // partial assistant message the shell already rendered, not lose it. A store
    // failure while flushing must not mask the original cancellation (a throw in
    // a catch replaces the in-flight exception), so preserve `e` regardless.
    try {
      if (assistantParts.length > 0) {
        await appendMessage(runtime, opts.sessionId, { kind: "assistant", id: assistantId, seq: 0, content: assistantParts, model: opts.agent.model })
      }
    } finally {
      throw e
    }
  }

  // Archive the assistant message (text + tool calls) to the log.
  await appendMessage(runtime, opts.sessionId, { kind: "assistant", id: assistantId, seq: 0, content: assistantParts, model: opts.agent.model })

  // Execute ANY tool call present this turn, regardless of finish_reason — a
  // provider may emit tool_calls alongside a "stop"/"length" finish, and we must
  // still run them and archive results or the next request becomes malformed.
  const toolCalls = assistantParts.filter((p): p is ToolCallPart => p.type === "tool-call")
  needsContinuation = toolCalls.length > 0

  if (toolCalls.length > 0) {
    // Run tools concurrently; archive results in call order so pairing is stable.
    // execpolicy defaults to deny-all so an unaudited tool never runs bare (M4).
    const ctx: ToolCtx = { caller: opts.caller ?? { kind: "parent", sessionId: opts.sessionId }, sessionId: opts.sessionId, signal: opts.signal, ...opts.toolCtx, execPolicy: opts.toolCtx?.execPolicy ?? denyAllExecPolicy }
    const settled = await Promise.allSettled(toolCalls.map((call) => invokeTool(opts.resolveTool, call, ctx, opts.signal)))
    for (let i = 0; i < settled.length; i++) {
      const call = toolCalls[i]!
      const outcome = settled[i]!
      if (outcome.status === "fulfilled") {
        await appendMessage(runtime, opts.sessionId, { kind: "tool", id: crypto.randomUUID(), seq: 0, callId: call.id, name: call.name, output: outcome.value })
        opts.onEvent?.({ type: "tool-result", name: call.name, output: outcome.value })
      } else {
        // A cancelled tool must be marked "Tool execution interrupted", matching
        // the cross-process convention in failInterruptedTools, so a resumed
        // session treats it as a durable interruption rather than a replayable
        // side effect. Any other rejection is a genuine tool error.
        const interrupted = isCancelled(outcome.reason)
        const text = interrupted ? "Tool execution interrupted" : `tool error: ${outcome.reason}`
        await appendMessage(runtime, opts.sessionId, { kind: "tool", id: crypto.randomUUID(), seq: 0, callId: call.id, name: call.name, output: text, isError: true })
        opts.onEvent?.({ type: "tool-result", name: call.name, output: text, isError: true })
      }
    }
  }

  await runtime.events.append(opts.sessionId, "Session.StepEnded", { sessionId: opts.sessionId, step, finish, usage } as Record<string, unknown>)
  return { needsContinuation, step, finish, usage }
}

async function appendMessage(runtime: TurnRuntime, sessionId: string, message: SessionMessage): Promise<void> {
  // Derive the next durable seq from the log so message.seq and event.seq align.
  const session = await loadSession(runtime.events, sessionId)
  const ev = session.projectMessage(message)
  await runtime.events.append(sessionId, ev.type, ev.data as Record<string, unknown>)
}

async function loadSession(events: TurnRuntime["events"], sessionId: string): Promise<Session> {
  const stored = await events.read(sessionId)
  if (stored.length === 0) return Session.create(sessionId, "")
  return Session.replay(stored)
}

function toSpec(tool: Tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

/** Race a tool's execution against an abort signal so a long-running tool can
 * be cancelled mid-execution (previously tools ran to completion regardless). */
async function invokeTool(resolveTool: (name: string) => Tool | undefined, call: ToolCallPart, ctx: ToolCtx, signal?: AbortSignal): Promise<unknown> {
  const tool = resolveTool(call.name)
  if (!tool) throw new Error(`unknown tool: ${call.name}`)
  const exec = tool.execute(call.input, ctx)
  if (!signal) return exec

  let rejectRef: ((reason: unknown) => void) | undefined
  const onAbort = () => {
    const err = new Error("tool execution aborted") as Error & { name: string }
    err.name = "AbortError"
    rejectRef?.(err)
  }
  const abort = new Promise<never>((_, reject) => {
    rejectRef = reject
    if (signal!.aborted) onAbort()
    else signal!.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([exec, abort])
  } finally {
    // Drop the listener so repeated tool calls do not accumulate a dangling
    // listener on a live session signal.
    signal!.removeEventListener("abort", onAbort)
  }
}

/**
 * Detect assistant messages that carried tool calls but whose results never
 * landed (a crash landed between tool start and settlement). Those calls are
 * "in flight" from a prior process; per "settlement is durable", we fail them
 * as interrupted rather than replaying side effects or feeding a malformed
 * next request. Idempotent: a callId already settled is never re-marked.
 */
async function failInterruptedTools(events: TurnRuntime["events"], sessionId: string, session: Session): Promise<void> {
  const messages = session.snapshot().messages
  // Collect settled tool result callIds.
  const settled = new Set<string>()
  for (const m of messages) if (m.kind === "tool") settled.add(m.callId)

  let pending: ToolCallPart[] | null = null
  let assistantId = ""
  for (const m of messages) {
    if (m.kind === "assistant") {
      pending = m.content.filter((p): p is ToolCallPart => p.type === "tool-call" && !settled.has(p.id))
      assistantId = m.id
      if (pending.length > 0) break
    }
  }

  if (!pending || pending.length === 0) return

  const session2 = await Session.replay(await events.read(sessionId))
  for (const call of pending) {
    const ev = session2.projectMessage({ kind: "tool", id: crypto.randomUUID(), seq: 0, callId: call.id, name: call.name, output: "Tool execution interrupted", isError: true })
    await events.append(sessionId, ev.type, ev.data as Record<string, unknown>)
  }
  // A prior run may have already recorded the interruption boundary when it was
  // cancelled (cancelledResult appends Session.Interrupted after flushing the
  // partial assistant that carries this unresolved tool-call). Re-appending here
  // would double-record the same interruption, so only emit it when the session
  // was NOT already marked interrupted after its last completed step (a crash
  // that skipped the graceful cancellation path has no such event yet).
  if (!(await interruptedAfterLastStep(events, sessionId))) {
    await events.append(sessionId, "Session.Interrupted", { sessionId })
  }
  void assistantId
}

/** True when a Session.Interrupted was already durably recorded after the most
 *  recent Session.StepEnded, meaning the interruption boundary is owned by an
 *  earlier (cancelled) run rather than this repair. */
async function interruptedAfterLastStep(events: TurnRuntime["events"], sessionId: string): Promise<boolean> {
  const stored = await events.read(sessionId)
  let seen = false
  for (const e of stored) {
    if (e.type === "Session.StepEnded") seen = false
    else if (e.type === "Session.Interrupted") seen = true
  }
  return seen
}

/** Normalize a provider-encoded tool input (JSON string or object) to an object. */
function normalizeToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}
