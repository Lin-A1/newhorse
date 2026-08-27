import type { LLMRequest, LLMEvent, ContentPart, ToolResultPart } from "@newhorse/schema"
import type { Protocol, Body } from "../route"

/**
 * Anthropic Messages protocol.
 *
 * Encodes a canonical LLMRequest into `POST /v1/messages` and decodes the SSE
 * `event:`-typed stream into canonical events. Anthropic accepts only `user` /
 * `assistant` roles and requires `tool_result` blocks to sit in a `user`
 * message immediately after the `tool_use` they answer. We therefore demote
 * the canonical `tool` role to `user` during encoding and interleave the
 * blocks in the same content array.
 *
 * Anthropic streams `input_json_delta` as fragmented `partial_json` across
 * chunks, and `tool_use` content carries `name`. We accumulate by tool id in
 * `content_block_start` (which also captures `name`) and flush ONE assembled
 * tool-call at `content_block_stop`.
 *
 * Thinking round-trip: Anthropic demands the original `thinking` block with its
 * `signature` be passed back verbatim on the next step of a multi-step tool
 * sequence. We carry the reasoning text + opaque `payload` (with signature)
 * that the loop may emit again; the payload is only replayed when the
 * continuation model matches the producing model.
 */
export const anthropicProtocol: Protocol = {
  id: "anthropic-messages",

  encode(request: LLMRequest): Body {
    const messages: Body[] = []
    const systemText: string[] = []

    for (let i = 0; i < request.messages.length; i++) {
      const m = request.messages[i]!
      if (m.role === "system") {
        systemText.push(textOf(m.content))
        continue
      }

      // Anthropic requires ALL tool_result for one assistant's tool_use set to
      // live in a SINGLE following user message. Multiple canonical `tool`
      // messages (one per result) are folded into one user message here.
      if (m.role === "tool") {
        const results = m.content.flatMap<Body>(mapContentPart)
        let j = i + 1
        while (j < request.messages.length && request.messages[j]!.role === "tool") {
          results.push(...request.messages[j]!.content.flatMap<Body>(mapContentPart))
          j++
        }
        messages.push({ role: "user", content: results })
        i = j - 1
        continue
      }

      const parts = m.content.flatMap<Body>((part) => mapContentPart(part))
      messages.push({ role: m.role, content: parts })
    }

    const body: Body = { model: request.model, messages, stream: true, max_tokens: request.maxTokens ?? 4096 }
    if (request.system) systemText.push(request.system)
    if (systemText.length > 0) body.system = systemText.join("\n\n")
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stop?.length) body.stop = request.stop

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
      }))
    }
    body.tool_choice = mapToolChoice(request.toolChoice)
    return body
  },

  init(): State {
    return { currentToolId: "", currentToolName: "", currentInput: "", inThinking: false, thinkingText: "" }
  },

  step(state: unknown, message: unknown): { state: State; events: LLMEvent[] } {
    const s = state as State
    const ev = message as AnthropicEvent
    const events: LLMEvent[] = []

    switch (ev.type) {
      case "content_block_start":
        if (ev.content_block?.type === "thinking") {
          s.inThinking = true
          s.thinkingSignature = ev.content_block.signature
        } else if (ev.content_block?.type === "tool_use") {
          s.currentToolId = ev.content_block.id ?? ""
          s.currentToolName = ev.content_block.name ?? ""
          s.currentInput = ""
        }
        break

      case "content_block_delta": {
        const delta = ev.delta
        if (delta?.type === "thinking_delta" && delta.thinking) {
          s.thinkingText += delta.thinking
          events.push({ type: "reasoning.delta", text: delta.thinking })
        } else if (delta?.type === "text_delta" && delta.text) {
          events.push({ type: "text.delta", text: delta.text })
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          s.currentInput += delta.partial_json
        }
        break
      }

      case "content_block_stop": {
        if (s.currentToolId && s.currentToolName) {
          events.push({ type: "tool-call", id: s.currentToolId, name: s.currentToolName, input: s.currentInput })
          s.currentToolId = ""
          s.currentToolName = ""
          s.currentInput = ""
        }
        if (s.inThinking && s.thinkingText.length > 0) {
          events.push({
            type: "reasoning.ended",
            text: s.thinkingText,
            ...(s.thinkingSignature ? { payload: { type: "thinking", signature: s.thinkingSignature } } : {}),
          })
          s.inThinking = false
          s.thinkingText = ""
          s.thinkingSignature = undefined
        }
        break
      }

      case "message_delta": {
        const finish = ev.delta?.stop_reason
        let semantic: "tool" | "length" | "stop" | "content-filter" | undefined
        if (finish === "tool_use") semantic = "tool"
        else if (finish === "max_tokens") semantic = "length"
        else if (finish === "end_turn") semantic = "stop"
        if (semantic) {
          const usage = ev.usage ?? ev.message?.usage
          events.push({
            type: "step-finish",
            finish: semantic,
            ...(usage ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}),
          })
        }
        break
      }

      case "message_stop":
        break

      case "error":
        events.push({ type: "provider-error", code: "provider", message: String(ev.error?.message ?? "unknown"), retryable: false })
        break
    }

    return { state: s, events }
  },
}

type AnthropicEvent = {
  type?: string
  content_block?: { type?: string; id?: string; thinking?: string; signature?: string; name?: string }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  error?: { message?: string }
}

interface State {
  currentToolId: string
  currentToolName: string
  currentInput: string
  inThinking: boolean
  thinkingText: string
  thinkingSignature?: string
}

function mapToolChoice(toolChoice: LLMRequest["toolChoice"]): unknown {
  if (!toolChoice || toolChoice === "auto") return { type: "auto" }
  if (toolChoice === "none") return { type: "none" }
  return { type: "tool", name: toolChoice.name }
}

function textOf(content: ContentPart[]): string {
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("")
}

function mapContentPart(part: ContentPart): Body[] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }]
    case "reasoning": {
      // When the payload carries an Anthropic signature, re-emit the thinking
      // block so the SAME model can continue a multi-step tool sequence with its
      // prior thinking. Otherwise (model switched) degrade to plain text.
      const sig = part.payload?.signature
      if (sig) {
        return [{ type: "thinking", thinking: part.text, signature: String(sig) }]
      }
      return [{ type: "text", text: part.text }]
    }
    case "tool-call":
      return [{ type: "tool_use", id: part.id, name: part.name, input: toJson(part.input) }]
    case "tool-result": {
      // tool_result lives inside a user message; return object so the caller
      // keeps it in the same content array as its tool_use sibling.
      return [{ type: "tool_result", tool_use_id: part.id, content: stringify(part.output) }]
    }
  }
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

function stringify(output: unknown): string {
  if (output === undefined) return ""
  if (typeof output === "string") return output
  return JSON.stringify(output)
}
