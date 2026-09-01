import type { LLMEvent, LLMRequest, SessionMessage, ContentPart, ToolCallPart } from "@newhorse/schema"
import type { TurnRuntime, Agent, Tool, ToolCall, ToolResult, ToolCtx, Initiator } from "./runner"
import { Session } from "../session/session"
import { toLlmMessages, resolveAttachmentImages } from "../session/messages"
import { projectCompacted, compactSession } from "./compaction"
import { currentGoal } from "./goal"
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

/**
 * Hook seam (deterministic command hooks — claude code's shape, wired via the
 * plugin registry in runtime; core only declares the contract so it never
 * imports plugin). A hook returns allow/block; a block carries a human-readable
 * reason injected back into the turn (e.g. a Stop hook can force another step).
 */
export type HookEvent = "stop" | "pre-tool-use"
export type HookVerdict = { readonly decision: "allow" | "block"; readonly reason?: string }

/** One completed model call (per provider turn). Metadata only — never request
 *  or response bodies, so a trace stays cheap to keep and safe to expose. */
export interface ModelCallInfo {
  readonly model: string
  /** Wall time of the streaming call in milliseconds. */
  readonly durationMs: number
  readonly finish: "tool" | "stop" | "length" | "content-filter" | "error"
  /** Provider usage payload as reported by the protocol (opaque, pass-through). */
  readonly usage?: unknown
  /** Serialized request size in characters (not bytes) — a cheap scale proxy. */
  readonly promptChars: number
  /** Assistant output size in characters (text + reasoning deltas). */
  readonly outputChars: number
  readonly toolCalls: number
  readonly error?: string
}

export interface RunOptions {
  readonly agent: Agent
  readonly sessionId: string
  /** Call a registered tool; throws on unknown tool. */
  readonly resolveTool: (name: string) => Tool | undefined
  /** Optional live-event sink for a shell to render streaming output. */
  readonly onEvent?: (event: LoopEvent) => void
  /** Optional hook seam (stop / pre-tool-use). Absent = no hooks. */
  readonly runHooks?: (event: HookEvent, input: unknown) => Promise<HookVerdict>
  /** Auto-compaction: when the visible history chars exceed the threshold,
   * fold the head once before the request (goal #2 long-horizon). Default on.
   * The threshold is MODEL-RELATIVE when the window is known (see
   * compactLimit); an explicit compactThreshold always wins. */
  readonly compactThreshold?: number
  readonly compactAuto?: boolean
  /** The current model's context window in tokens (host/model config supplies
   * it; it is deliberately NOT a built-in per-model table — that would make
   * core captive to a model registry). Scales the compaction trigger. */
  readonly contextWindowTokens?: number
  /** Chars-per-token ratio for the window->chars conversion (CJK ≈ 1,
   * English ≈ 4; the default 2.5 is a conservative mixed-content value). */
  readonly charsPerToken?: number
  /** Output budget for the model's replies (tokens). When absent, protocols
   * apply their own fallback — the anthropic protocol MUST send a value (the
   * API requires it) and would silently truncate at its conservative floor. */
  readonly maxOutputTokens?: number
  /** Optional LLM summarizer used by compaction (head text -> summary). The
   * runtime injects it from its LLM client; absent = cheap local marker. */
  readonly compactSummarize?: (headText: string) => Promise<string>
  /**
   * Observability seam: invoked once per completed provider turn with call
   * metadata (model-io trace). A throwing callback propagates like a failed
   * StepEnded append — the caller owns whether a broken trace sink is fatal.
   */
  readonly onModelCall?: (info: ModelCallInfo) => void | Promise<void>
  /** Goal budget enforcement: when an ACTIVE goal's tokenBudget is exceeded by
   * the aggregated persisted usage, pause the run durably (finish="length",
   * goal status -> blocked). Default on. */
  readonly goalEnforce?: boolean
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
    // Compaction trigger (AGENTS.md goal #2): measure the VISIBLE (projected)
    // history. When it exceeds the char budget, fold the head — the projection
    // only drops what the SUMMARY MARKER already represents (seq <= boundary),
    // so a later compaction simply folds the NEW head that has grown since the
    // last boundary. This is a long-horizon session's escape hatch: it fires
    // as often as needed (never re-folds the same tail, because the tail is
    // what the projection keeps), so a session cannot outgrow the window after
    // its first compaction.
    const storedForCompaction = await runtime.events.read(opts.sessionId)
    const { messages: visibleCheck } = projectCompacted(storedForCompaction)
    // Goal budget enforcement (goal layer): when the ACTIVE goal carries a
    // tokenBudget and the session's aggregated usage exceeds it, pause the run
    // durably — a steer tells the model the budget is spent, the drain stops
    // (needsContinuation=false, finish="length"), and the operator decides
    // whether to raise the budget or stop. Enforced BEFORE the next request.
    const goal = currentGoal(storedForCompaction)
    if (opts.goalEnforce !== false && goal?.status === "active" && goal.tokenBudget !== undefined && goal.tokensUsed > goal.tokenBudget) {
      await runtime.inbox.admit({ id: crypto.randomUUID(), sessionId: opts.sessionId, prompt: `[goal budget] token budget exhausted (${goal.tokensUsed} > ${goal.tokenBudget}). The run is paused — raise the budget via goal_write or start a new session.`, delivery: "steer", principal: "parent" })
      await runtime.events.append(opts.sessionId, "Session.GoalUpdated", { sessionId: opts.sessionId, objective: goal.objective, status: "blocked", tokenBudget: goal.tokenBudget, ts: Date.now() })
      const result: TurnResult = { needsContinuation: false, step: turns, finish: "length" }
      opts.onEvent?.({ type: "done", step: result.step, needsContinuation: false, finish: "length" })
      return result
    }
    if (opts.compactAuto !== false) {
      const chars = visibleCheck.reduce((n, m) => n + JSON.stringify(m).length, 0)
      if (chars > compactLimit(opts)) {
        await compactSession(runtime.events, opts.sessionId, { summarize: opts.compactSummarize, maxTailChars: compactionTailChars(opts) })
      }
    }
    // Compaction-aware projection: if a Session.Compacted boundary exists, the
    // folded head is DROPPED from the model's view (its summary marker stands
    // in) — this is what actually bounds the request window; the full log stays
    // durable. The boundary is read from the store so the projection is exact.
    const { messages: visibleMessages } = projectCompacted(await runtime.events.read(opts.sessionId))
    // Content-addressed attachment refs hydrate ONLY on the last user turn
    // (same aging rule as inline images) before the request is built.
    const attachmentImages = await resolveAttachmentImages(visibleMessages, runtime.attachments)
    const messages = toLlmMessages(visibleMessages, opts.agent.model, attachmentImages)
    if (messages.length === 0) {
      // Nothing promoted and no history yet — drain is done.
      break
    }

    // Step budget (opencode MAX_STEPS_PROMPT): when close to the cap, TELL the
    // model in-band (a user message, never the system prefix — that would
    // perturb the Anthropic cache anchor) so it winds up instead of hitting
    // a hard wall it cannot see.
    const remaining = MAX_STEPS - turns
    if (remaining <= 5) {
      const budgetNote = `[budget] ${remaining} step(s) left this run; wrap up your answer now.`
      messages.push({ role: "user", content: [{ type: "text", text: budgetNote }] })
    }

    const request: LLMRequest = {
      model: opts.agent.model,
      messages,
      tools: opts.agent.tools?.map(toSpec),
      maxTokens: opts.maxOutputTokens,
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

    // Stop hook (deterministic, claude code Stop-event shape): a block can
    // force another step with a reason re-injected as a steer — the "loop until
    // done" control that does not live in the model.
    if (!needsContinuation && opts.runHooks) {
      const verdict = await opts.runHooks("stop", { step: turns, finish: lastStepEnded })
      if (verdict.decision === "block") {
        const reason = verdict.reason ?? "continue"
        await runtime.inbox.admit({ id: crypto.randomUUID(), sessionId: opts.sessionId, prompt: reason, delivery: "steer" })
        needsContinuation = true
      }
    }
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

  const streamStart = performance.now()
  const stream = await runtime.llm.stream(request, opts.signal)
  let providerError: string | undefined
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
          providerError = event.message
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

  // Model-io trace (per completed provider call). Fires BEFORE tool execution —
  // it describes the MODEL call, not the turn. Tool-call parts count toward
  // toolCalls; text+reasoning deltas count toward outputChars.
  if (opts.onModelCall) {
    let outputChars = 0
    for (const p of assistantParts) {
      if (p.type === "text" || p.type === "reasoning") outputChars += p.text.length
    }
    await opts.onModelCall({
      model: opts.agent.model,
      durationMs: Math.round(performance.now() - streamStart),
      finish,
      ...(usage !== undefined ? { usage } : {}),
      // Cheap scale proxy WITHOUT serializing image base64 (a 20MiB image must
      // not allocate a ~27MB string on every call): sum text-ish field sizes.
      promptChars: request.messages.reduce((n, m) => n + m.content.reduce((k, part) => k + (typeof (part as { text?: string }).text === "string" ? ((part as { text?: string }).text ?? "").length : 0), 0), 0),
      outputChars,
      toolCalls: assistantParts.filter((p): p is ToolCallPart => p.type === "tool-call").length,
      ...(providerError !== undefined ? { error: providerError } : {}),
    })
  }

  // Execute ANY tool call present this turn, regardless of finish_reason — a
  // provider may emit tool_calls alongside a "stop"/"length" finish, and we must
  // still run them and archive results or the next request becomes malformed.
  const toolCalls = assistantParts.filter((p): p is ToolCallPart => p.type === "tool-call")
  needsContinuation = toolCalls.length > 0

  if (toolCalls.length > 0) {
    // Run tools concurrently; archive results in call order so pairing is stable.
    // execpolicy defaults to deny-all so an unaudited tool never runs bare (M4).
    // pre-tool-use hook: a block skips the execution and records the reason as
    // an error result — the model sees the denial and self-corrects.
    const ctx: ToolCtx = { caller: opts.caller ?? { kind: "parent", sessionId: opts.sessionId }, sessionId: opts.sessionId, signal: opts.signal, ...opts.toolCtx, execPolicy: opts.toolCtx?.execPolicy ?? denyAllExecPolicy }
    const settled = await Promise.allSettled(toolCalls.map(async (call) => {
      if (opts.runHooks) {
        const verdict = await opts.runHooks("pre-tool-use", { name: call.name, input: call.input })
        if (verdict.decision === "block") {
          // A denied call is an ERROR result (durable, isError:true) — the
          // model sees the denial and self-corrects; it is NOT a silent skip.
          throw new Error(`denied by hook: ${verdict.reason ?? "blocked"}`)
        }
      }
      return invokeTool(opts.resolveTool, call, ctx, opts.signal)
    }))
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

/** Model-relative compaction budget: explicit compactThreshold wins; else a
 *  FRACTION of the model's own window (a 32k-token model must trigger before
 *  it overflows, a 200k-token model must not summarize half-empty); else the
 *  fixed 80k-char fallback (window unknown). Chars stay the measure — no
 *  tokenizer dependency; charsPerToken converts, conservatively. The 0.6
 *  fraction leaves headroom for the turn's own reply + tool outputs (a turn
 *  can add a lot before the next check). */
const COMPACT_WINDOW_FRACTION = 0.6
const COMPACT_CHAR_FALLBACK = 80_000
export function compactLimit(opts: Pick<RunOptions, "compactThreshold" | "contextWindowTokens" | "charsPerToken">): number {
  if (opts.compactThreshold !== undefined) return opts.compactThreshold
  if (opts.contextWindowTokens !== undefined) return Math.floor(opts.contextWindowTokens * (opts.charsPerToken ?? 2.5) * COMPACT_WINDOW_FRACTION)
  return COMPACT_CHAR_FALLBACK
}

/** Byte budget for the RETAINED TAIL after a fold (the trigger folds when the
 *  visible history exceeds compactLimit; the tail that survives the fold must
 *  be strictly smaller, else the trigger re-fires every turn with nothing to
 *  fold). Explicit window scaling; fixed 30k-char fallback. */
export function compactionTailChars(opts: Pick<RunOptions, "contextWindowTokens" | "charsPerToken">): number {
  if (opts.contextWindowTokens !== undefined) return Math.floor(opts.contextWindowTokens * (opts.charsPerToken ?? 2.5) * 0.3)
  return 30_000
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
