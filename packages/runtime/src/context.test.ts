import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "@newhorse/core"
import { ensureSystemContext } from "./context"

async function seeded(events: MemoryEventStore, id = "s1"): Promise<void> {
  await events.append(id, "Session.Created", { id, location: "G:/proj", createdAt: Date.now() })
}

describe("ensureSystemContext", () => {
  it("appends exactly one system message for a fresh session", async () => {
    const events = new MemoryEventStore()
    await seeded(events)
    await ensureSystemContext(events, "s1", "G:/proj", async () => "Workdir: G:/proj\n\n# deep\n")
    const log = await events.read("s1")
    const systems = log.filter((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "system")
    expect(systems.length).toBe(1)
    expect((systems[0]!.data as { message?: { text?: string } }).message?.text).toContain("Workdir: G:/proj")
  })

  it("is idempotent on a second call (does not re-append)", async () => {
    const events = new MemoryEventStore()
    await seeded(events)
    await ensureSystemContext(events, "s1", "G:/proj", async () => "ctx")
    await ensureSystemContext(events, "s1", "G:/proj", async () => "ctx")
    const log = await events.read("s1")
    expect(log.filter((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "system").length).toBe(1)
  })

  it("concurrent calls for the same session collapse to one system message (no double-append)", async () => {
    const events = new MemoryEventStore()
    await seeded(events)
    // A slow provider forces both callers into the read-before-append window.
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => (release = r))
    const slow = async (): Promise<string> => {
      await gate
      return "slow-context"
    }
    const p1 = ensureSystemContext(events, "s1", "G:/proj", slow)
    const p2 = ensureSystemContext(events, "s1", "G:/proj", slow)
    await new Promise((r) => setTimeout(r, 20)) // let both reach the gate
    release?.()
    await Promise.all([p1, p2])

    const log = await events.read("s1")
    const systems = log.filter((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "system")
    expect(systems.length).toBe(1)
    expect((systems[0]!.data as { message?: { text?: string } }).message?.text).toContain("slow-context")
  })

  it("returns without appending when the provider yields an empty string", async () => {
    const events = new MemoryEventStore()
    await seeded(events)
    await ensureSystemContext(events, "s1", "G:/proj", async () => "")
    const log = await events.read("s1")
    expect(log.filter((e) => e.type === "Session.MessageAppended")).toHaveLength(0)
  })
})
