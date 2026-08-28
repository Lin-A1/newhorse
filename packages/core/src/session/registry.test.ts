import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "./store"
import { SessionRegistry, fold } from "./registry"
import type { StoredEvent } from "@newhorse/schema"

const created = (id: string, location: string, createdAt = Date.now()): StoredEvent => ({
  aggregate: "session",
  aggregate_id: id,
  seq: 0,
  type: "Session.Created",
  data: { id, location, createdAt },
})

describe("session registry", () => {
  it("folds a session's events into a row", () => {
    const row = fold([
      created("s1", "/proj"),
      { aggregate: "session", aggregate_id: "s1", seq: 1, type: "Session.StepEnded", data: { sessionId: "s1", step: 1, finish: "stop" } },
    ])
    expect(row?.sessionId).toBe("s1")
    expect(row?.workspace).toBe("/proj")
    expect(row?.status).toBe("settled")
    expect(row?.createdAt).toBeGreaterThan(0)
  })

  it("tracks interrupted status", () => {
    const row = fold([
      created("s1", "/proj"),
      { aggregate: "session", aggregate_id: "s1", seq: 1, type: "Session.Interrupted", data: { sessionId: "s1" } },
    ])
    expect(row?.status).toBe("interrupted")
  })

  it("lists sessions filtered by workspace and status (lazy hydration)", async () => {
    const events = new MemoryEventStore()
    await events.append("s1", "Session.Created", { id: "s1", location: "/a", createdAt: 1 })
    await events.append("s1", "Session.StepEnded", { sessionId: "s1", step: 1, finish: "stop" })
    await events.append("s2", "Session.Created", { id: "s2", location: "/b", createdAt: 2 })

    const registry = new SessionRegistry(events)
    const all = await registry.list()
    expect(all.length).toBe(2)

    const inA = await registry.list({ workspace: "/a" })
    expect(inA.length).toBe(1)
    expect(inA[0]?.sessionId).toBe("s1")

    const settled = await registry.list({ status: "settled" })
    expect(settled.length).toBe(1)
    expect(settled[0]?.sessionId).toBe("s1")
  })

  it("gets a single session and returns undefined when unknown", async () => {
    const events = new MemoryEventStore()
    await events.append("s1", "Session.Created", { id: "s1", location: "/a", createdAt: 1 })
    const registry = new SessionRegistry(events)
    expect((await registry.get("s1"))?.sessionId).toBe("s1")
    expect(await registry.get("nope")).toBeUndefined()
  })

  it("refresh() picks up events appended after the index was hydrated (no dead index)", async () => {
    const events = new MemoryEventStore()
    await events.append("s1", "Session.Created", { id: "s1", location: "/a", createdAt: 1 })
    const registry = new SessionRegistry(events)

    // First read hydrates the index as "created"/"active".
    expect((await registry.get("s1"))?.status).toBe("created")

    // A later interrupt is appended after hydration — a new app/run path.
    await events.append("s1", "Session.Interrupted", { sessionId: "s1" })
    await registry.refresh()
    expect((await registry.get("s1"))?.status).toBe("interrupted")
  })

  it("fold records parentId from Session.Spawned", async () => {
    const events = new MemoryEventStore()
    await events.append("s1", "Session.Created", { id: "s1", location: "/a", createdAt: 1 })
    await events.append("s1", "Session.Spawned", { sessionId: "s1", parentId: "p1" })
    const registry = new SessionRegistry(events)
    expect((await registry.get("s1"))?.parentId).toBe("p1")
  })

  it("audit() folds butler actions from the audit aggregate", async () => {
    const events = new MemoryEventStore()
    await events.append("audit:b1", "Session.ButlerAction", { sessionId: "b1", actorKind: "butler", actorId: "b1", op: "send_to_session", targetSessionId: "s1", outcome: "denied", reason: "butler requires explicit user authorization", ts: 100 })
    await events.append("audit:b1", "Session.ButlerAction", { sessionId: "b1", actorKind: "parent", actorId: "p1", op: "send_to_session", targetSessionId: "s1", outcome: "allowed", ts: 200 })
    const registry = new SessionRegistry(events)
    const rows = await registry.audit("b1")
    expect(rows.length).toBe(2)
    expect(rows[0]?.outcome).toBe("allowed") // newest first
    expect(rows[1]?.reason).toContain("butler requires")
  })
})
