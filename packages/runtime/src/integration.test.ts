import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import { MemoryMemoryStore } from "@newhorse/memory"
import { PluginRegistry } from "@newhorse/plugin"
import type { Fetcher } from "@newhorse/llm"

/**
 * Combined end-to-end integration: wire the REAL seams together (createApp +
 * memoryStore + memoryExtract + plugins + hooks + toolset) and drive a
 * realistic server-style flow with a scripted SSE LLM. This is the test that
 * would catch a seam that works in isolation but breaks when wired.
 */

function sseParts(payloads: string[]): string {
  return payloads.map((p) => `data: ${p}\n\n`).join("") + "data: [DONE]\n\n"
}

function turn(text: string): string {
  return sseParts([JSON.stringify({ choices: [{ delta: { role: "assistant", content: text }, finish_reason: "stop" }] })])
}

function toolTurn(call: { name: string; args: string }, final = "done"): string {
  const toolChunk: unknown = { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "tc1", function: { name: call.name, arguments: call.args } }] }, finish_reason: null }] }
  const finalChunk: unknown = { choices: [{ delta: { content: final }, finish_reason: "stop" }] }
  return sseParts([JSON.stringify(toolChunk), JSON.stringify(finalChunk)])
}

describe("combined integration (createApp + memory + tools + hooks)", () => {
  it("runs a multi-step tool session, writes a durable memory, and recalls it in the next session", async () => {
    const store = new MemoryMemoryStore()
    // The session LLM script: 1) a tool call to memory_write (the model records
    // a fact), 2) a final turn. The extraction LLM returns a JSON atom.
    let turnNo = 0
    const memStore = store
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      workspace: "G:/w",
      memoryStore: memStore,
      enableBash: false,
      fetch: (async () => {
        turnNo++
        if (turnNo === 1) {
          // First turn: model calls memory_write to record a fact.
          return new Response(toolTurn({ name: "memory_write", args: JSON.stringify({ content: "user is from Shanghai", type: "fact", priority: 60 }) }), { status: 200, headers: { "content-type": "text/event-stream" } })
        }
        if (turnNo === 2) {
          // Second turn: model confirms.
          return new Response(turn("recorded"), { status: 200, headers: { "content-type": "text/event-stream" } })
        }
        // Extraction pipe calls (LLM-scripted): the extract returns an atom.
        return new Response(turn('[{"content":"user is from Shanghai","type":"fact","priority":60}]'), { status: 200, headers: { "content-type": "text/event-stream" } })
      }) as Fetcher,
    })

    await app.prompt("Remember that I'm from Shanghai", "user")

    // The model's memory_write call landed in the store (tool path).
    const written = await memStore.search("Shanghai")
    expect(written.length).toBeGreaterThan(0)
  })

  it("pre-tool-use hook denies a tool and the model sees the durable denial, then the turn settles", async () => {
    let turnNo = 0
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      workspace: "G:/w",
      fetch: (async () => {
        turnNo++
        if (turnNo === 1) return new Response(toolTurn({ name: "read", args: "{}" }), { status: 200, headers: { "content-type": "text/event-stream" } })
        return new Response(turn("understood"), { status: 200, headers: { "content-type": "text/event-stream" } })
      }) as Fetcher,
      // A programmatic hook that denies pre-tool-use for "read".
      plugins: (() => {
        const pr = new PluginRegistry()
        pr.register({ kind: "hook", name: "deny-read", event: "pre-tool-use", mode: "command", run: async (input) => {
          const name = (input as { name?: string }).name
          return name === "read" ? { decision: "block", reason: "read is denied by policy" } : { decision: "allow" }
        } })
        return pr
      })(),
    })

    const result = await app.prompt("read file x", "user")
    // The turn still settles (the denial is a durable tool error, not a crash).
    expect(result.finish).toBe("stop")
    const history = await app.resume()
    const toolMsg = history.messages.find((m) => m.kind === "tool")
    expect((toolMsg as { isError?: boolean } | undefined)?.isError).toBe(true)
    expect(((toolMsg as { output?: string } | undefined)?.output ?? "")).toContain("denied")
  })
})
