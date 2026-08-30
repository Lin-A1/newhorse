import { describe, expect, it, afterEach } from "bun:test"
import { createSdkClient, type SdkClient } from "./index"
import { createServer, type ServerHandle } from "../../server/src/server"
import type { AdapterConfig } from "@newhorse/llm"

const provider: AdapterConfig = { kind: "openai", baseUrl: "https://x", apiKey: "k" }

function sse(payload: string): Response {
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

let handle: ServerHandle | undefined
afterEach(async () => {
  await handle?.stop()
  handle = undefined
})

describe("@newhorse/sdk (reuse entry point)", () => {
  it("drives a full session over the server: create → prompt(SSE) → steer → snapshot → events", async () => {
    const payload = [
      "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hello from the runtime" }, finish_reason: "stop" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    handle = await createServer({ port: 0, sessionConfig: () => ({ provider, model: "m", fetch: async () => sse(payload) }) })
    const client: SdkClient = createSdkClient({ baseUrl: handle.baseUrl })

    const sessionId = await client.createSession({ workspace: "G:/w" })
    expect(sessionId).toBeTruthy()

    const events: string[] = []
    const result = await client.prompt(sessionId, "say hi", (e) => events.push(e.type))
    expect(result.finish).toBe("stop")
    expect(events).toContain("text")
    expect(events).toContain("result")

    // Steer + read it back from the durable log (admission is the delivery proof).
    await client.steer(sessionId, "sdk steer")
    const log = await client.events(sessionId)
    expect(log.some((e) => e.type === "Session.PromptAdmitted")).toBe(true)

    const snap = await client.snapshot(sessionId)
    expect(snap.id).toBe(sessionId)

    const sessions = await client.sessions()
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true)
  })

  it("token auth flows through the SDK", async () => {
    handle = await createServer({ port: 0, token: "sekret", sessionConfig: () => ({ provider, model: "m", fetch: async () => sse("data: [DONE]\n\n") }) })
    const bad = createSdkClient({ baseUrl: handle.baseUrl })
    await expect(bad.createSession()).rejects.toThrow(/401/)
    const good = createSdkClient({ baseUrl: handle.baseUrl, token: "sekret" })
    const id = await good.createSession()
    expect(id).toBeTruthy()
  })
})
