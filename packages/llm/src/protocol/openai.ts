import type { LLMRequest, LLMEvent } from "@newhorse/schema"
import type { Protocol, Body } from "../route"

/**
 * OpenAI-compatible chat protocol.
 *
 * Encodes a canonical LLMRequest into the `POST /chat/completions` body and
 * decodes the SSE `data:` chunks (choice deltas) into canonical events. This
 * single protocol is reused by any provider that speaks the OpenAI wire shape
 * (openai, deepseek, together, cerebras, openai-compatible gateways, ...) —
 * only the endpoint + auth differ.
 *
 * OpenAI splits tool_calls across chunks keyed by `index`. We accumulate per
 * index across chunks and emit ONE assembled tool-call when it completes, so
 * downstream never sees half-assembled JSON.
 */
export const openaiProtocol: Protocol = {
  id: "openai-chat",

  encode(request: LLMRequest): Body {
    const messages: Record<string, unknown>[] = []
    for (const m of request.messages) {
      // A canonical message may hold multiple tool-results (e.g. several settled
      // tool calls folded into one row). OpenAI requires ONE tool message per
      // tool_call_id, so emit each result as its own message rather than taking
      // the first (which silently dropped the rest — a data-loss bug).
      const toolResults = m.content.filter((p) => p.type === "tool-result")
      if (m.role === "tool") {
        for (const tr of toolResults) {
          // Never emit `content: undefined` (OpenAI requires tool content, and
          // JSON.stringify(undefined) yields `undefined` which is dropped from
          // the JSON body -> a 400). A tool that resolved to `undefined` is
          // encoded as the string "undefined" so the field is always present.
          const out = tr.output === undefined ? "undefined" : JSON.stringify(toJson(tr.output))
          messages.push({ role: "tool", content: out, tool_call_id: tr.id })
        }
        continue
      }

      const text = textOfContent(m.content)
      const toolCalls = m.content.filter((p) => p.type === "tool-call")
      const message: Record<string, unknown> = {
        role: m.role,
        // Never emit `content: undefined` (a reasoning-only assistant message):
        // lower reasoning text to plain content (model-relative lowering drops
        // the opaque payload) or, when nothing remains, null for an assistant
        // that only produced tool calls, else "" so the field never vanishes.
        content: text.length > 0 ? text : toolCalls.length > 0 ? null : m.role === "assistant" ? "" : null,
      }

      if (m.role === "assistant" && toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((p) => ({
          id: (p as { id: string }).id,
          type: "function",
          function: { name: (p as { name: string }).name, arguments: JSON.stringify(toJson((p as { input: unknown }).input)) },
        }))
      }
      messages.push(message)
    }

    const body: Body = { model: request.model, messages, stream: true }
    // Always ask for usage (stream_options.include_usage) so input/output/cache
    // tokens surface for cost accounting (goal #3). This is NOT coupled to
    // cacheControl: OpenAI caches automatically and has no client-side cache
    // marker, so opts out of "cacheControl" must not silently suppress token
    // accounting. cacheControl is an Anthropic-only concern (explicit marker).
    body.stream_options = { include_usage: true }
    if (request.system) body.system = request.system
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.stop?.length) body.stop = request.stop
    body.tool_choice = mapToolChoice(request.toolChoice)
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } },
      }))
    }
    return body
  },

  init(): State {
    return { role: null, text: "", reasoning: "", toolAcc: new Map<number, { id: string; name: string; input: string }>(), finish: undefined }
  },

  step(state: unknown, message: unknown): { state: State; events: LLMEvent[] } {
    const s = state as State
    const events: LLMEvent[] = []
    const chunk = message as ChatChunk

    // Usage may arrive on a chunk with or without choices. Record it without
    // consuming the semantic finish latch, so a later "tool_calls" finish_reason
    // still flushes the accumulated tool calls (some gateways send usage in the
    // same chunk as the finish).
    if (chunk.usage) {
      s.usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens }
    }

    const delta = chunk.choices?.[0]?.delta
    if (!delta) {
      if (s.usage && !s.finish) {
        s.finish = "stop"
        events.push({ type: "step-finish", finish: "stop", usage: s.usage })
      }
      return { state: s, events }
    }

    if (delta.role && s.role === null) s.role = delta.role

    if (delta.reasoning_content) {
      s.reasoning += delta.reasoning_content
      events.push({ type: "reasoning.delta", text: delta.reasoning_content })
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      s.text += delta.content
      events.push({ type: "text.delta", text: delta.content })
    }

    // Accumulate tool-call fragments by index; emit each completed call once.
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const existing = s.toolAcc.get(idx) ?? { id: tc.id ?? "", name: "", input: "" }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (tc.function?.arguments) existing.input += tc.function.arguments
        s.toolAcc.set(idx, existing)
      }
    }

    const finishReason = chunk.choices?.[0]?.finish_reason
    if (finishReason && !s.finish) {
      s.finish = finishReason
      // Flush assembled tool calls before the finish event.
      for (const [, call] of s.toolAcc) {
        if (call.id || call.name) {
          events.push({ type: "tool-call", id: call.id, name: call.name, input: call.input })
        }
      }
      s.toolAcc.clear()
      events.push({ type: "step-finish", finish: normalizeFinish(finishReason), ...(s.usage ? { usage: s.usage } : {}) })
    }

    return { state: s, events }
  },
}

interface State {
  role: string | null
  text: string
  reasoning: string
  toolAcc: Map<number, { id: string; name: string; input: string }>
  finish: string | undefined
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
}

type ChatChunk = {
  choices?: { delta?: { role?: string; content?: string; reasoning_content?: string; tool_calls?: ToolCallFragment[] }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
}

type ToolCallFragment = {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

function mapToolChoice(toolChoice: LLMRequest["toolChoice"]): unknown {
  if (!toolChoice || toolChoice === "auto") return "auto"
  if (toolChoice === "none") return "none"
  return { type: "function", function: { name: toolChoice.name } }
}

function textOfContent(content: LLMRequest["messages"][number]["content"]): string {
  // Model-relative lowering: a reasoning part degrades to plain text (opaque
  // provider payload dropped) so a reasoning-only assistant turn stays
  // model-visible rather than being dropped at the wire.
  return content
    .map((p) => (p.type === "text" ? p.text : p.type === "reasoning" ? p.text : ""))
    .filter(Boolean)
    .join("")
}

function toJson(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input)
    } catch {
      return input
    }
  }
  return input
}

function normalizeFinish(reason: string): "stop" | "length" | "tool" | "content-filter" {
  switch (reason) {
    case "length":
      return "length"
    case "function_call":
    case "tool_calls":
      return "tool"
    case "content_filter":
      return "content-filter"
    default:
      return "stop"
  }
}
