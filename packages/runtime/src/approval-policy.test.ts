import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import type { Fetcher } from "@newhorse/llm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function sseToolCall(): Response {
  const toolChunk: unknown = { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "tc1", function: { name: "write", arguments: '{"path":"a.txt","content":"hi"}' } }] }, finish_reason: null }] }
  const finalChunk: unknown = { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }
  const payload = ["data: " + JSON.stringify(toolChunk) + "\n\n", "data: " + JSON.stringify(finalChunk) + "\n\n", "data: [DONE]\n\n"].join("")
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** Capture the tool surface the model actually sees. */
async function toolsSeen(policy: "strict" | "trusted" | "readonly"): Promise<string[]> {
  let seen: string[] = []
  // The wire body arrives as init.body — parse it there.
  const capturing: Fetcher = async (_input, init) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { tools?: { function?: { name: string } }[] }
    seen = (parsed.tools ?? []).map((t) => t.function!.name)
    return sseToolCall()
  }
  void fetch
  const workspace = await mkdtemp(join(tmpdir(), "nh-policy-"))
  try {
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace,
      approvalPolicy: policy,
      fetch: capturing,
    })
    await app.prompt("go", "user")
    return seen
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

describe("approvalPolicy (permission levels)", () => {
  it("readonly filters side-effecting tools from the model's surface", async () => {
    const seen = await toolsSeen("readonly")
    expect(seen).not.toContain("write")
    expect(seen).not.toContain("bash")
    expect(seen).toContain("read")
    expect(seen).toContain("todo_write") // session-internal checklist stays
  })

  it("strict keeps the full surface (write present)", async () => {
    const seen = await toolsSeen("strict")
    expect(seen).toContain("write")
    expect(seen).toContain("read")
  })

  it("trusted keeps the full surface (the floor is what short-circuits)", async () => {
    const seen = await toolsSeen("trusted")
    expect(seen).toContain("write")
  })
})

describe("readonly execution (denial path)", () => {
  it("a hallucinated write call resolves to unknown tool (never executes)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nh-ro-run-"))
    try {
      const fetch: Fetcher = async () => sseToolCall()
      const app = await createApp({
        provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace,
        approvalPolicy: "readonly",
        fetch,
      })
      const result = await app.prompt("write a.txt", "user")
      expect(result.finish).toBe("stop")
      // a.txt must NOT exist — the write never ran.
      const { readFile } = await import("node:fs/promises")
      await expect(readFile(join(workspace, "a.txt"), "utf8")).rejects.toThrow()
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {})
    }
  })
})
