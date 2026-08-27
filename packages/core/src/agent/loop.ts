import type { LLMEvent, LLMRequest, SessionMessage, ContentPart, ToolCallPart } from "@newhorse/schema"
import type { TurnRuntime, Agent, Tool, ToolCall, ToolResult } from "./runner"
import { Session } from "../session/session"
import { toLlmMessages } from "../session/messages"

/** Hard cap on steps per drain to guarantee termination. */
const MAX_STEPS = 50

export interface TurnResult {
  readonly needsContinuation: boolean
  readonly step: number
}

export interface RunOptions {
  readonly agent: Agent
  readonly sessionId: string
  /** Call a registered tool; throws on unknown tool. */
  readonly resolveTool: (name: string) => Tool | undefined
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
  let lastStepEnded: "tool" | "stop" | "length" | "content-filter" = "tool"

  while (needsContinuation && turns < MAX_STEPS) {
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

    const turn = await runTurn(runtime, opts, request, turns)
    needsContinuation = turn.needsContinuation
    lastStepEnded = turn.finish
  }

  return { needsContinuation: needsContinuation && lastStepEnded === "tool", step: turns }
}

/**
 * One provider turn: stream the request, archive assistant text + tool calls,
 * execute tools, and settle. Returns whether another turn is required.
 */
async function runTurn(runtime: TurnRuntime, opts: RunOptions, request: LLMRequest, step: number): Promise<{ needsContinuation: boolean; step: number; finish: "tool" | "stop" | "length" | "content-filter" }> {
  const assistantId = crypto.randomUUID()
  const assistantParts: ContentPart[] = []

  let needsContinuation = false
  let finish: "tool" | "stop" | "length" | "content-filter" = "stop"

  const stream = await runtime.llm.stream(request)
  for await (const event of stream) {
    switch (event.type) {
      case "text.delta": {
        const last = assistantParts[assistantParts.length - 1]
        if (last?.type === "text") assistantParts[assistantParts.length - 1] = { type: "text", text: last.text + event.text }
        else assistantParts.push({ type: "text", text: event.text })
        break
      }
      case "reasoning.delta": {
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
      case "tool-call":
        assistantParts.push({ type: "tool-call", id: event.id, name: event.name, input: event.input })
        break
      case "step-finish":
        finish = event.finish
        break
      case "provider-error":
        finish = "stop"
        needsContinuation = false
        break
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
    const settled = await Promise.allSettled(toolCalls.map((call) => invokeTool(opts.resolveTool, call)))
    for (let i = 0; i < settled.length; i++) {
      const call = toolCalls[i]!
      const outcome = settled[i]!
      if (outcome.status === "fulfilled") {
        await appendMessage(runtime, opts.sessionId, { kind: "tool", id: crypto.randomUUID(), seq: 0, callId: call.id, name: call.name, output: outcome.value })
      } else {
        await appendMessage(runtime, opts.sessionId, { kind: "tool", id: crypto.randomUUID(), seq: 0, callId: call.id, name: call.name, output: `tool error: ${outcome.reason}`, isError: true })
      }
    }
  }

  await runtime.events.append(opts.sessionId, "Session.StepEnded", { sessionId: opts.sessionId, step, finish })
  return { needsContinuation, step, finish }
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

async function invokeTool(resolveTool: (name: string) => Tool | undefined, call: ToolCallPart): Promise<unknown> {
  const tool = resolveTool(call.name)
  if (!tool) throw new Error(`unknown tool: ${call.name}`)
  return tool.execute(call.input)
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
  await events.append(sessionId, "Session.Interrupted", { sessionId })
  void assistantId
}
