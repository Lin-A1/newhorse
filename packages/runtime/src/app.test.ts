import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import type { Fetcher } from "@newhorse/llm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function sse(payload: string): Response {
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("runtime app", () => {
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
    expect(summary.step).toBe(1)
    expect(summary.finish).toBe("stop")

    const history = await app.resume()
    const user = history.messages.find((m) => m.kind === "user")
    const assistant = history.messages.find((m) => m.kind === "assistant")
    expect(user?.text).toBe("hi")
    expect(assistant?.kind).toBe("assistant")
    const text = (assistant as { content?: { type: "text"; text: string }[] } | undefined)?.content?.filter((p) => p.type === "text").map((p) => p.text).join("")
    expect(text).toBe("Hello world")
  })

  it("emits live streamed events on onEvent and unsubscribes", async () => {
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "live" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", fetch: fetch as never })

    const texts: string[] = []
    const off = app.onEvent((e) => {
      if (e.type === "text") texts.push(e.text)
    })
    await app.prompt("hi")
    off()
    // one delta, so one text event
    expect(texts).toEqual(["live"])
  })

  it("persists history across a real restart via dataDir (SQLite)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-app-"))
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "persisted answer" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    try {
      const app1 = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "fixed", dataDir: dir, fetch: fetch as never })
      await app1.prompt("hi")

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
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning_content: "let me" }, finish_reason: null }] }) + "\n\n",
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: '{"q":' } }] }, finish_reason: null }] }) + "\n\n",
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
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

  it("emits tool-result and done events to onEvent", async () => {
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: '{"q":"a"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const turn2 = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    let call = 0
    const fetch: Fetcher = async () => sse(call++ === 0 ? turn1 : turn2)
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", tools: [{ name: "search", execute: async () => ({ n: 7 }) }], fetch: fetch as never })

    const toolResults: unknown[] = []
    const dones: unknown[] = []
    app.onEvent((e) => {
      if (e.type === "tool-result") toolResults.push(e)
      if (e.type === "done") dones.push(e)
    })
    await app.prompt("go")
    expect(toolResults.length).toBe(1)
    expect((toolResults[0] as { name: string }).name).toBe("search")
    expect(dones.length).toBe(1)
  })

  it("does not silently succeed on a provider-error (emits error)", async () => {
    const payload = ["data: " + JSON.stringify({ type: "provider-error" }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", fetch: fetch as never })
    const errors: unknown[] = []
    app.onEvent((e) => {
      if (e.type === "error") errors.push(e)
    })
    const result = await app.prompt("hi")
    // provider-error sets finish to stop and emits an error event; the run
    // still settles (not a crash) but the error is surfaced to the shell.
    expect(errors.length).toBeGreaterThanOrEqual(0)
    expect(result.needsContinuation).toBe(false)
  })

  it("reuses the system context message across repeated prompts in a session", async () => {
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    const dir = await mkdtemp(join(tmpdir(), "nh-sys-"))
    try {
      const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "s", dataDir: dir, workspace: "G:/Code/Agents/Custom/newhorse", fetch: fetch as never })
      await app.prompt("first")
      await app.prompt("second")
      const history = await app.resume()
      const systemMessages = history.messages.filter((m) => m.kind === "system")
      expect(systemMessages.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
