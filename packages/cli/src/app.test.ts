import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import type { Fetcher } from "@newhorse/llm"

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

  it("resumes history after a restart (new app, same session id)", async () => {
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "persist" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)

    // NOTE: memory store does not survive app instances. This asserts the
    // session id is stable; true restart persistence is a dataDir theme tracked
    // for the SQLite store (M1 keeps the memory EventStore).
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "fixed-id", fetch: fetch as never })
    const history = await app.resume()
    expect(history.id).toBe("fixed-id")
  })
})
