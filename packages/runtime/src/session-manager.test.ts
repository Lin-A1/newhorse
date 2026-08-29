import { describe, expect, it } from "bun:test"
import { MemoryEventStore, MemorySessionInput, type TurnRuntime } from "@newhorse/core"
import { driveChildSession, readChildText } from "./session-manager"
import type { LLMEvent } from "@newhorse/schema"

function eventsOf(events: LLMEvent[]): AsyncIterable<LLMEvent> {
  return (async function* () {
    for (const e of events) yield e
  })()
}

function stubLlm(text: string): TurnRuntime["llm"] {
  return {
    id: "t",
    stream: async () => eventsOf([{ type: "text.delta", text }, { type: "step-finish", finish: "stop" }]),
  }
}

describe("driveChildSession (Phase 3)", () => {
  it("creates the child, injects system context, runs it, and returns its text", async () => {
    const events = new MemoryEventStore()
    const inbox = new MemorySessionInput(events)
    const runtime: TurnRuntime = { events, inbox, llm: stubLlm("RESULT123") }
    const childId = "child-1"

    const res = await driveChildSession({
      runtime, inbox, events, sessionId: childId,
      workspace: "G:/proj",
      agent: { id: "a", model: "m", tools: [] },
      tools: [],
      prompt: "do the work",
      contextProvider: async () => "Workdir: G:/proj",
    })

    expect(res.settled).toBe(true)
    expect(res.text).toContain("RESULT123")
    // Durable artifacts: Created with real location + the system message.
    const log = await events.read(childId)
    const created = log.find((e) => e.type === "Session.Created")
    expect((created?.data as { location?: string }).location).toBe("G:/proj")
    const system = log.find((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "system")
    expect((system?.data as { message?: { text?: string } }).message?.text).toContain("Workdir: G:/proj")
  })

  it("readChildText joins assistant text parts from the durable log", async () => {
    const events = new MemoryEventStore()
    const childId = "child-3"
    await events.append(childId, "Session.Created", { id: childId, location: "G:/proj", createdAt: Date.now() })
    await events.append(childId, "Session.MessageAppended", { sessionId: childId, message: { kind: "assistant", id: "m1", seq: 1, version: 1, content: [{ type: "text", text: "hello" }], model: "m" } })
    await events.append(childId, "Session.MessageAppended", { sessionId: childId, message: { kind: "assistant", id: "m2", seq: 2, version: 1, content: [{ type: "text", text: " world" }], model: "m" } })
    const text = await readChildText(events, childId)
    // Each assistant message is one paragraph (joined with \n), not concatenated.
    expect(text).toContain("hello")
    expect(text).toContain("world")
  })
})
