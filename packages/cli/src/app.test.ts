import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import type { Fetcher } from "@newhorse/llm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function sse(payload: string): Response {
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("cli app", () => {
  it("runs a single prompt through admission → turn → history", async () => {
    const payload = [
      "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hello" }, finish_reason: null }] }) + "\n\n",
      "data: " + JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")

    const fetch: Fetcher = async () => sse(payload)
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
      model: "test-model",
      workspace: "/proj",
      fetch: fetch as never,
    })

    const summary = await app.prompt("hi")
    expect(summary).toBe("done")

    const history = await app.resume()
    const user = history.messages.find((m) => m.kind === "user")
    const assistant = history.messages.find((m) => m.kind === "assistant")
    expect(user?.text).toBe("hi")
    expect(assistant?.kind).toBe("assistant")
    const text = (assistant as { content?: { type: "text"; text: string }[] } | undefined)?.content?.filter((p) => p.type === "text").map((p) => p.text).join("")
    expect(text).toBe("Hello world")
  })

  it("persists history + pending prompt across a real restart via dataDir (SQLite)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-app-"))
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "persisted answer" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    try {
      // First app writes to disk.
      const app1 = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "fixed", dataDir: dir, fetch: fetch as never })
      await app1.prompt("hi")

      // Second app, same dataDir + sessionId, rebuilds the same history.
      const app2 = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "fixed", dataDir: dir, fetch: fetch as never })
      const history = await app2.resume()
      expect(history.id).toBe("fixed")
      const assistant = history.messages.find((m) => m.kind === "assistant")
      const text = (assistant as { content?: { type: "text"; text: string }[] } | undefined)?.content?.filter((p) => p.type === "text").map((p) => p.text).join("")
      expect(text).toBe("persisted answer")
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("runs a realistic OpenAI multi-turn wire: fragmented tool-call then result then final text", async () => {
    // Turn 1: reasoning + a tool-call whose arguments are split across chunks.
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning_content: "let me" }, finish_reason: null }] }) + "\n\n",
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: '{"q":' } }] }, finish_reason: null }] }) + "\n\n",
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    // Turn 2: model sees the tool result and produces final text.
    const turn2 = ["data: " + JSON.stringify({ choices: [{ delta: { content: "found it" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")

    let call = 0
    const fetch: Fetcher = async () => sse(call++ === 0 ? turn1 : turn2)
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
      model: "test-model",
      workspace: "/proj",
      tools: [{ name: "search", execute: async () => ({ n: 2 }) }],
      fetch: fetch as never,
    })

    await app.prompt("search something")

    // The fragmented tool-call must have assembled into ONE tool message keyed
    // to call_1, proving the multi-turn OpenAI wire loop works end to end.
    const history = await app.resume()
    const tool = history.messages.find((m) => m.kind === "tool")
    expect((tool as { callId?: string } | undefined)?.callId).toBe("call_1")
    const assistant = history.messages.filter((m) => m.kind === "assistant")
    const finalText = assistant
      .at(-1)!
      .content.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
    expect(finalText).toBe("found it")
  })
})
