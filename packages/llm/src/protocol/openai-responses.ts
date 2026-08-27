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
    // Responses uses `input` (a message array) + optional `instructions`.
    const input: unknown[] = []
    let instructions: string[] = []
    for (const m of request.messages) {
      if (m.role === "system") {
        instructions.push(textOfContent(m.content))
        continue
      }
      const content = m.content.flatMap((p) => mapContentPart(p))
      input.push({ role: m.role === "tool" ? "user" : m.role, content })
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
    return { text: "", reasoning: "", toolAcc: new Map<string, { id: string; name: string; input: string }>(), finish: undefined }
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

      case "response.completed": {
        const usage = ev.response?.usage
        events.push({
          type: "step-finish",
          finish: "stop",
          ...(usage ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}),
        })
        s.finish = "stop"
        break
      }

      case "response.failed": {
        const code = ev.response?.error?.code ?? "provider"
        const message = ev.response?.error?.message ?? "response failed"
        events.push({ type: "provider-error", code, message, retryable: false })
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
  toolAcc: Map<string, { id: string; name: string; input: string }>
  finish: string | undefined
}

type ResponseEvent = {
  type?: string
  delta?: string
  item?: Item
  response?: { usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string } }
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
  return toolChoice.name
}

function textOfContent(content: LLMRequest["messages"][number]["content"]): string {
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("")
}

function mapContentPart(part: LLMRequest["messages"][number]["content"][number]): unknown[] {
  switch (part.type) {
    case "text":
      return [{ type: "input_text", text: part.text }]
    case "reasoning":
      return [{ type: "input_text", text: part.text }]
    case "tool-call":
      return [{ type: "function_call", call_id: part.id, name: part.name, arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input) }]
    case "tool-result":
      return [{ type: "function_call_output", call_id: part.id, output: typeof part.output === "string" ? part.output : JSON.stringify(part.output) }]
  }
}
