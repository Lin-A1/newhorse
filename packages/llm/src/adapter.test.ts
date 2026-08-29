import { describe, expect, it } from "bun:test"
import { openaiProtocol } from "./protocol/openai"
import { openaiResponsesProtocol } from "./protocol/openai-responses"
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

  it("folds multiple tool-results in one message into separate tool messages (no data loss)", () => {
    const body = openaiProtocol.encode(
      req({
        messages: [
          { role: "tool", content: [{ type: "tool-result", id: "c1", name: "a", output: { n: 1 } }, { type: "tool-result", id: "c2", name: "b", output: { n: 2 } }] },
        ],
      }),
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: "tool", tool_call_id: "c1" })
    expect(messages[1]).toMatchObject({ role: "tool", tool_call_id: "c2" })
    expect((messages[0]!.content as string).includes("1")).toBe(true)
    expect((messages[1]!.content as string).includes("2")).toBe(true)
  })

  it("never emits content undefined for a reasoning-only assistant message", () => {
    const body = openaiProtocol.encode(
      req({
        messages: [{ role: "assistant", content: [{ type: "reasoning", text: "think" }] }],
      }),
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[0]!.content).toBe("")
    expect("content" in messages[0]!).toBe(true)
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

  it("merges usage from message_start (input/cache) with message_delta (output)", () => {
    // Real Anthropic placement: input/cache in message_start, output in message_delta.
    let state = anthropicProtocol.init() as unknown
    let r = anthropicProtocol.step(state, { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 12 } } })
    expect(r.events).toEqual([])
    state = r.state
    r = anthropicProtocol.step(state, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })
    const finish = r.events.find((e) => e.type === "step-finish")
    expect(finish).toMatchObject({ finish: "stop", usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, cacheWriteTokens: 12 } })
  })

  it("still reads usage when the gateway puts everything in message_delta (MiniMax shape)", () => {
    const state = anthropicProtocol.init() as unknown
    const r = anthropicProtocol.step(state, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 } })
    const finish = r.events.find((e) => e.type === "step-finish")
    expect(finish).toMatchObject({ usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 } })
  })
})

describe("openai responses protocol", () => {
  it("encodes to /v1/responses shape with input + instructions + structured tools", () => {
    const body = openaiResponsesProtocol.encode(
      req({
        messages: [
          { role: "system", content: [{ type: "text", text: "be brief" }] },
          { role: "user", content: [{ type: "text", text: "hi" }] },
        ],
        tools: [{ name: "search", description: "d" }],
      }),
    )
    expect(body.model).toBe("test-model")
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe("be brief")
    expect(body.tools).toEqual([{ type: "function", name: "search", description: "d", parameters: { type: "object", properties: {} } }])
    expect(body.max_output_tokens).toBeUndefined() // no maxTokens provided
  })

  it("emits tool calls and results as top-level input items with an object tool_choice", () => {
    const body = openaiResponsesProtocol.encode(
      req({
        messages: [
          { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "search", input: { q: "a" } }] },
          { role: "tool", content: [{ type: "tool-result", id: "c1", name: "search", output: { n: 2 } }] },
        ],
        toolChoice: { name: "search" },
      }),
    )
    const input = body.input as Record<string, unknown>[]
    // tool-call and tool-result are top-level items, not nested in a message.
    expect(input[0]).toEqual({ type: "function_call", call_id: "c1", name: "search", arguments: '{"q":"a"}' })
    expect(input[1]).toEqual({ type: "function_call_output", call_id: "c1", output: '{"n":2}' })
    expect(body.tool_choice).toEqual({ type: "function", name: "search" })
  })

  it("decodes output_text deltas and completes with usage", () => {
    const state = openaiResponsesProtocol.init() as unknown
    const r1 = openaiResponsesProtocol.step(state, { type: "response.output_text.delta", delta: "Hello" })
    expect(r1.events).toEqual([{ type: "text.delta", text: "Hello" }])
    const r2 = openaiResponsesProtocol.step(r1.state, { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } })
    expect(r2.events).toEqual([{ type: "step-finish", finish: "stop", usage: { inputTokens: 10, outputTokens: 4 } }])
  })

  it("decodes a function_call output item into a single tool-call", () => {
    const state = openaiResponsesProtocol.init() as unknown
    const r = openaiResponsesProtocol.step(state, {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_1", name: "search", arguments: '{"q":"a"}' },
    })
    expect(r.events).toEqual([{ type: "tool-call", id: "call_1", name: "search", input: '{"q":"a"}' }])
  })

  it("decodes reasoning deltas", () => {
    const state = openaiResponsesProtocol.init() as unknown
    const r = openaiResponsesProtocol.step(state, { type: "response.reasoning_text.delta", delta: "let me think" })
    expect(r.events).toEqual([{ type: "reasoning.delta", text: "let me think" }])
  })

  it("emits a retryable provider-error on a rate-limited response.failed", () => {
    const state = openaiResponsesProtocol.init() as unknown
    const r = openaiResponsesProtocol.step(state, { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "slow down" } } })
    expect(r.events).toEqual([{ type: "provider-error", code: "rate_limit_exceeded", message: "slow down", retryable: true }])
  })

  it("reports a truncated/incomplete response as length, not stop", () => {
    const state = openaiResponsesProtocol.init() as unknown
    const r = openaiResponsesProtocol.step(state, { type: "response.completed", response: { status: "incomplete" } })
    expect(r.events).toEqual([{ type: "step-finish", finish: "length" }])
  })

  it("reads cached_tokens from responses usage (cost-down visibility)", () => {
    const state = openaiResponsesProtocol.init() as unknown
    const r = openaiResponsesProtocol.step(state, { type: "response.completed", response: { status: "completed", usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } } } })
    expect(r.events.at(-1)).toEqual({ type: "step-finish", finish: "stop", usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80 } })
  })

  it("emits assistant text before its tool-call items (correct conversation order)", () => {
    const body = openaiResponsesProtocol.encode(
      req({
        messages: [{ role: "assistant", content: [{ type: "text", text: "found it" }, { type: "tool-call", id: "c1", name: "search", input: { q: "a" } }] }],
      }),
    )
    const input = body.input as { type?: string; role?: string }[]
    const textIdx = input.findIndex((i) => i.type === undefined || i.type === "message")
    const callIdx = input.findIndex((i) => i.type === "function_call")
    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(callIdx).toBeGreaterThan(textIdx)
    expect(input[0]!.role).toBe("assistant")
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
