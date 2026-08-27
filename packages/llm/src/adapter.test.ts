import { describe, expect, it } from "bun:test"
import { openaiProtocol } from "./protocol/openai"
import { anthropicProtocol } from "./protocol/anthropic"
import { makeLlmClient } from "./adapter"
import type { Fetcher } from "./route"
import type { LLMRequest } from "@newhorse/schema"

function req(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return { model: "test-model", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...overrides }
}

describe("openai protocol", () => {
  it("encodes a simple request to chat/completions shape", () => {
    const body = openaiProtocol.encode(req())
    expect(body.model).toBe("test-model")
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("encodes assistant tool_calls and tool-result messages", () => {
    const body = openaiProtocol.encode(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "do it" }] },
          { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "search", input: { q: "a" } }] },
          { role: "tool", content: [{ type: "tool-result", id: "c1", name: "search", output: { n: 2 } }] },
        ],
      }),
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[1]!.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "search", arguments: '{"q":"a"}' } }])
    expect(messages[2]!.tool_call_id).toBe("c1")
  })

  it("decodes SSE delta chunks into canonical events", () => {
    const state = openaiProtocol.init() as unknown
    const chunk = { choices: [{ delta: { role: "assistant", content: "Hello" }, finish_reason: null }] }
    const r1 = openaiProtocol.step(state, chunk)
    expect(r1.events).toEqual([{ type: "text.delta", text: "Hello" }])

    const chunk2 = { choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }
    const r2 = openaiProtocol.step(r1.state, chunk2)
    expect(r2.events.some((e) => e.type === "step-finish")).toBe(true)
  })

  it("accumulates a fragmented tool_call across chunks into one assembled call", () => {
    let state = openaiProtocol.init() as unknown
    const chunk1 = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: '{"q":' } }] }, finish_reason: null }] }
    let r = openaiProtocol.step(state, chunk1)
    expect(r.events).toEqual([]) // no tool-call until finish

    state = r.state
    const chunk2 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] }
    r = openaiProtocol.step(state, chunk2)
    expect(r.events).toEqual([
      { type: "tool-call", id: "call_1", name: "search", input: '{"q":"a"}' },
      { type: "step-finish", finish: "tool" },
    ])
  })

  it("handles usage on a final chunk with no delta (no duplicate step-finish)", () => {
    const state = openaiProtocol.init() as unknown
    const r = openaiProtocol.step(state, { usage: { prompt_tokens: 10, completion_tokens: 4 } })
    expect(r.events).toEqual([{ type: "step-finish", finish: "stop", usage: { inputTokens: 10, outputTokens: 4 } }])
  })
})

describe("anthropic protocol", () => {
  it("encodes to /v1/messages shape with tool_use blocks", () => {
    const body = anthropicProtocol.encode(
      req({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "search", description: "d" }],
      }),
    )
    expect(body.stream).toBe(true)
    expect(body.tools).toEqual([{ name: "search", description: "d", input_schema: { type: "object", properties: {} } }])
  })

  it("decodes thinking_delta and message_delta into canonical events", () => {
    const state = anthropicProtocol.init() as unknown
    const r1 = anthropicProtocol.step(state, { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "let me" } })
    expect(r1.events).toEqual([{ type: "reasoning.delta", text: "let me" }])
    const r2 = anthropicProtocol.step(r1.state, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 3 } })
    expect(r2.events.some((e) => e.type === "step-finish" && e.finish === "stop")).toBe(true)
  })

  it("accumulates input_json_delta fragments and flushes one tool-call at content_block_stop", () => {
    let state = anthropicProtocol.init() as unknown
    let r = anthropicProtocol.step(state, { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "search" } })
    expect(r.events).toEqual([])
    state = r.state
    r = anthropicProtocol.step(state, { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"q":' } })
    expect(r.events).toEqual([])
    state = r.state
    r = anthropicProtocol.step(state, { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '"a"}' } })
    expect(r.events).toEqual([])
    state = r.state
    r = anthropicProtocol.step(state, { type: "content_block_stop" })
    expect(r.events).toEqual([{ type: "tool-call", id: "toolu_1", name: "search", input: '{"q":"a"}' }])
  })

  it("demotes tool role to user and keeps tool_result nested", () => {
    const body = anthropicProtocol.encode(
      req({
        messages: [
          { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "search", input: { q: "a" } }] },
          { role: "tool", content: [{ type: "tool-result", id: "c1", name: "search", output: { n: 2 } }] },
        ],
      }),
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[0]!.role).toBe("assistant")
    expect(messages[1]!.role).toBe("user") // tool demoted to user
    const content = messages[1]!.content as Record<string, unknown>[]
    expect(content[0]!.type).toBe("tool_result")
    expect(content[0]!.tool_use_id).toBe("c1")
  })

  it("folds adjacent tool messages into a single user message", () => {
    const body = anthropicProtocol.encode(
      req({
        messages: [
          { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "a", input: {} }, { type: "tool-call", id: "c2", name: "b", input: {} }] },
          { role: "tool", content: [{ type: "tool-result", id: "c1", name: "a", output: 1 }] },
          { role: "tool", content: [{ type: "tool-result", id: "c2", name: "b", output: 2 }] },
        ],
      }),
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[1]!.role).toBe("user")
    const content = messages[1]!.content as Record<string, unknown>[]
    // Both tool results collapsed into the one following user message.
    expect(content.length).toBe(2)
    expect(content[0]!.tool_use_id).toBe("c1")
    expect(content[1]!.tool_use_id).toBe("c2")
  })
})

describe("makeLlmClient with injected fetch", () => {
  it("captures the endpoint and headers", async () => {
    let capturedUrl = ""
    let capturedHeaders: Record<string, string> | undefined
    const fakeFetch: Fetcher = async (url, init) => {
      capturedUrl = String(url)
      capturedHeaders = init?.headers as Record<string, string>
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    }

    const client = makeLlmClient({ kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" }, fakeFetch)
    const events: unknown[] = []
    for await (const e of await client.stream(req())) events.push(e)

    expect(capturedUrl).toBe("https://api.example.com/v1/chat/completions")
    const headers = capturedHeaders as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer k")
    // No events since [DONE] terminates immediately.
  })

  it("throws LlmHttpError with taxonomy on 429/5xx", async () => {
    const fakeFetch: Fetcher = async () => new Response("rate limited", { status: 429 })
    const client = makeLlmClient({ kind: "anthropic", baseUrl: "https://api.example.com", apiKey: "k", maxRetries: 0 }, fakeFetch)
    let err: unknown
    try {
      for await (const _ of await client.stream(req())) void _
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ status: 429, retryable: true })
  })

  it("retries a retryable 429 and succeeds on the next attempt", async () => {
    let attempts = 0
    const fakeFetch: Fetcher = async () => {
      attempts += 1
      if (attempts === 1) return new Response("rate limited", { status: 429 })
      return new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n" + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const client = makeLlmClient({ kind: "openai", baseUrl: "https://api.example.com", apiKey: "k", maxRetries: 2 }, fakeFetch)
    const text: string[] = []
    for await (const e of await client.stream(req())) {
      if (e.type === "text.delta") text.push(e.text)
    }
    expect(attempts).toBe(2)
    expect(text.join("")).toBe("ok")
  })
})
