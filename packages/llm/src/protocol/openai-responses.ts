import type { LLMRequest, LLMEvent } from "@newhorse/schema"
import type { Protocol, Body } from "../route"

/**
 * OpenAI Responses protocol (`POST /v1/responses`).
 *
 * This is OpenAI's current recommended interface (used by Codex) and differs
 * from the older Chat Completions protocol: it emits SSE events such as
 * `response.output_text.delta`, `response.output_item.done`, and
 * `response.completed`, rather than `choices[].delta`.
 *
 * It fits the same four-axis Route shape as `openaiProtocol` — only the encode
 * body shape and the decode event-mapping differ. The agent loop is unchanged;
 * a provider that speaks Responses just uses this protocol.
 *
 * Tool calls arrive as `response.output_item.done` items of type `function_call`
 * carrying `name`/`arguments`/`call_id` assembled in one shot (no cross-chunk
 * accumulation needed, unlike Chat Completions).
 */
export const openaiResponsesProtocol: Protocol = {
  id: "openai-responses",

  encode(request: LLMRequest): Body {
    // Responses uses `input` (an array of input items) + optional `instructions`.
    // Tool calls/results are TOP-LEVEL input items ({type:"function_call", ...},
    // {type:"function_call_output", ...}); plain text stays inside a
    // {role, content:[input_text]} message.
    const input: unknown[] = []
    let instructions: string[] = []
    for (const m of request.messages) {
      if (m.role === "system") {
        instructions.push(textOfContent(m.content))
        continue
      }

      // Emit tool-call / tool-result items at the top level.
      const toolCalls = m.content.filter((p) => p.type === "tool-call")
      const toolResults = m.content.filter((p) => p.type === "tool-result")
      for (const tc of toolCalls) input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: toJsonString(tc.input) })
      for (const tr of toolResults) input.push({ type: "function_call_output", call_id: tr.id, output: toJsonString(tr.output) })

      // Remaining text (and reasoning lowered to text) becomes a message item.
      const text = textOfContent(m.content)
      if (text) input.push({ role: m.role, content: [{ type: "input_text", text }] })
    }

    const body: Body = { model: request.model, input, stream: true }
    if (request.system) instructions.push(request.system)
    if (instructions.length > 0) body.instructions = instructions.join("\n\n")
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
    if (request.stop?.length) body.stop = request.stop
    body.tool_choice = mapToolChoice(request.toolChoice)
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      }))
    }
    return body
  },

  init(): State {
    return { text: "", reasoning: "", finish: undefined }
  },

  step(state: unknown, message: unknown): { state: State; events: LLMEvent[] } {
    const s = state as State
    const events: LLMEvent[] = []
    const ev = message as ResponseEvent

    switch (ev.type) {
      // Streaming text.
      case "response.output_text.delta":
        if (ev.delta) {
          s.text += ev.delta
          events.push({ type: "text.delta", text: ev.delta })
        }
        break

      // Streaming reasoning (two variants).
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (ev.delta) {
          s.reasoning += ev.delta
          events.push({ type: "reasoning.delta", text: ev.delta })
        }
        break

      // A completed output item (message text, function call, reasoning block).
      case "response.output_item.done": {
        const item = ev.item as Item | undefined
        if (!item) break
        if (item.type === "function_call") {
          events.push({ type: "tool-call", id: item.call_id ?? "", name: item.name ?? "", input: item.arguments ?? "" })
        } else if (item.type === "reasoning") {
          // A whole reasoning block; treat any text as reasoning.
          for (const part of item.summary ?? []) {
            if (part.text) events.push({ type: "reasoning.delta", text: part.text })
          }
        } else if (item.type === "message") {
          for (const part of item.content ?? []) {
            if (part.type === "output_text" && part.text) {
              // Ensure text is emitted (in case delta was not seen).
              if (!s.text.includes(part.text)) events.push({ type: "text.delta", text: part.text })
            }
          }
        }
        break
      }

      case "response.incomplete": {
        // truncated: report length so compaction/cost logic sees it, not "stop".
        events.push({ type: "step-finish", finish: "length" })
        s.finish = "length"
        break
      }

      case "response.completed": {
        const usage = ev.response?.usage
        const status = ev.response?.status
        // A completed response may still be truncated (status "incomplete").
        const finish = status === "incomplete" ? "length" : "stop"
        events.push({ type: "step-finish", finish, ...(usage ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}) })
        s.finish = finish
        break
      }

      case "response.failed": {
        const code = ev.response?.error?.code ?? "provider"
        const message = ev.response?.error?.message ?? "response failed"
        // A stream-resident failure can still be retryable (rate limit, server
        // overload). surface the retryability so the caller may retry rather
        // than treating every failure as fatal.
        const retryable = isRetryable(code)
        events.push({ type: "provider-error", code, message, retryable })
        s.finish = "stop"
        break
      }

      case "error": {
        const code = ev.error?.code ?? "provider"
        const message = ev.error?.message ?? "response error"
        events.push({ type: "provider-error", code, message, retryable: isRetryable(code) })
        s.finish = "stop"
        break
      }

      default:
        // Unhandled (response.created, output_item.added, content_part.*, etc).
        break
    }

    return { state: s, events }
  },
}

interface State {
  text: string
  reasoning: string
  finish: string | undefined
}

type ResponseEvent = {
  type?: string
  delta?: string
  item?: Item
  error?: { code?: string; message?: string }
  response?: { status?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string } }
}

type Item = {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  summary?: Array<{ text?: string }>
  content?: Array<{ type?: string; text?: string }>
}

function mapToolChoice(toolChoice: LLMRequest["toolChoice"]): unknown {
  if (!toolChoice || toolChoice === "auto") return "auto"
  if (toolChoice === "none") return "none"
  return { type: "function", name: toolChoice.name }
}

/** Whether a Responses stream-resident failure code is retryable. */
function isRetryable(code: string): boolean {
  return code === "rate_limit_exceeded" || code === "server_error" || code === "server_is_overloaded" || code === "slow_down"
}

function textOfContent(content: LLMRequest["messages"][number]["content"]): string {
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("")
}

/** Encode a tool input/output as a JSON string for the wire. */
function toJsonString(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value)
}
