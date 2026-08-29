import { describe, expect, it } from "bun:test"
import { MemoryEventStore, MemorySessionInput, type TurnRuntime } from "@newhorse/core"
import { createSessionHub } from "./hub"
import { driveChildSession } from "./session-manager"
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

describe("hub spawn + driver closure (spawn → live child → settle → promote)", () => {
  it("spawn with a driver runs the child and promotes its result into the parent inbox", async () => {
    const events = new MemoryEventStore()
    const inbox = new MemorySessionInput(events)
    const runtime: TurnRuntime = { events, inbox, llm: stubLlm("CHILD-ANSWER") }
    // The app-style driver: driveChildSession + Settled + parent promotion.
    const driver = async (childId: string, parentId: string, childWorkspace: string, _model?: string, prompt?: string): Promise<void> => {
      const driven = await driveChildSession({
        runtime, inbox, events, sessionId: childId, workspace: childWorkspace,
        agent: { id: "spawned", model: "m", tools: [] }, tools: [], prompt: prompt ?? "task",
      })
      await events.append(childId, "Session.Settled", { sessionId: childId, finish: driven.finish, needsContinuation: false })
      if (driven.settled) {
        await inbox.admit({ id: crypto.randomUUID(), sessionId: parentId, prompt: `[child ${childId} result]\n${driven.text}`, delivery: "steer", principal: "parent" })
      }
    }
    const hub = createSessionHub(events, () => ({ interrupt: () => {}, prompt: async () => "" }), "G:/proj", driver)

    // Parent session + a baseline history so it exists.
    const parentId = "parent-1"
    await events.append(parentId, "Session.Created", { id: parentId, location: "G:/proj", createdAt: Date.now() })

    const childId = await hub.spawn(parentId, "cheap-model", "Inspect the repo")

    // The driver is fire-and-forget (spawn returns immediately); wait for the
    // child to settle durably before asserting.
    let settled = false
    for (let i = 0; i < 50 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 10))
      settled = (await events.read(childId)).some((e) => e.type === "Session.Settled")
    }
    expect(settled).toBe(true)
    // Child was actually driven (fire-and-forget, but settled on the log).
    const childLogNow = await events.read(childId)
    const childText = childLogNow.filter((e) => e.type === "Session.MessageAppended").map((e) => (e.data as { message?: { kind?: string } }).message?.kind).join(",")
    expect(childText).toContain("assistant")

    // Parent inbox got the promotion as a pending steer (admitted after settle).
    expect(await inbox.hasPending(parentId, "steer")).toBe(true)
    const promoted = await inbox.promoteSteers(parentId, await events.latestSeq(parentId))
    expect(promoted).toBe(1)
    const parentLog = await events.read(parentId)
    const promotedMsg = parentLog.find((e) => e.type === "Session.Prompted")
    expect((promotedMsg?.data as { prompt?: string }).prompt).toContain("CHILD-ANSWER")
  })
})
