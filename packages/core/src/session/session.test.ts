import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "./store"
import { MemorySessionInput, SessionInputError } from "./input"
import { Session } from "./session"
import type { SessionMessage } from "@newhorse/schema"

describe("admission inbox", () => {
  it("admits idempotently: exact reuse returns the same receipt", async () => {
    const inbox = new MemorySessionInput(new MemoryEventStore())
    const a = await inbox.admit({ id: "m1", sessionId: "s1", prompt: "hi", delivery: "steer" })
    const b = await inbox.admit({ id: "m1", sessionId: "s1", prompt: "hi", delivery: "steer" })
    expect(b.admittedSeq).toBe(a.admittedSeq)
    expect(b.prompt).toBe("hi")
  })

  it("collapses concurrent admits of a brand-new id into one durable event", async () => {
    const store = new MemoryEventStore()
    const inbox = new MemorySessionInput(store)
    // Fire many parallel admits of the same new id; exactly one may win the
    // durable append, the rest must observe the same receipt.
    const admits = await Promise.all(
      Array.from({ length: 20 }, () => inbox.admit({ id: "n1", sessionId: "s1", prompt: "hi", delivery: "steer" })),
    )
    const first = admits[0]!
    expect(admits.every((a) => a.admittedSeq === first.admittedSeq && a.sessionId === "s1")).toBe(true)
    const emitted = await store.read("s1")
    const admitted = emitted.filter((e) => e.type === "Session.PromptAdmitted")
    expect(admitted).toHaveLength(1)
  })

  it("fails when the same id is reused for a different session/prompt/delivery", async () => {
    const inbox = new MemorySessionInput(new MemoryEventStore())
    await inbox.admit({ id: "m1", sessionId: "s1", prompt: "hi", delivery: "steer" })
    expect(inbox.admit({ id: "m1", sessionId: "s1", prompt: "different", delivery: "steer" })).rejects.toThrow(SessionInputError)
  })

  it("promotes all eligible steers admitted at or before cutoff", async () => {
    const inbox = new MemorySessionInput(new MemoryEventStore())
    await inbox.admit({ id: "m1", sessionId: "s1", prompt: "a", delivery: "steer" })
    await inbox.admit({ id: "m2", sessionId: "s1", prompt: "b", delivery: "steer" })
    const promoted = await inbox.promoteSteers("s1", 2)
    expect(promoted).toBe(2)
    expect(await inbox.hasPending("s1", "steer")).toBe(false)
  })

  it("drains queue one at a time after steers", async () => {
    const inbox = new MemorySessionInput(new MemoryEventStore())
    await inbox.admit({ id: "m1", sessionId: "s1", prompt: "a", delivery: "steer" })
    await inbox.admit({ id: "m2", sessionId: "s1", prompt: "queued", delivery: "queue" })
    await inbox.promoteSteers("s1", 2)
    expect(await inbox.promoteNextQueued("s1")).toBe(true)
    expect(await inbox.hasPending("s1", "queue")).toBe(false)
  })

  it("steer does not promote queued inputs", async () => {
    const inbox = new MemorySessionInput(new MemoryEventStore())
    await inbox.admit({ id: "m1", sessionId: "s1", prompt: "queued", delivery: "queue" })
    const promoted = await inbox.promoteSteers("s1", 2)
    expect(promoted).toBe(0)
    expect(await inbox.hasPending("s1", "queue")).toBe(true)
  })

  it("survives restart: hydrate() rebuilds pending rows from the log", async () => {
    const store = new MemoryEventStore()
    const inbox1 = new MemorySessionInput(store)
    await inbox1.admit({ id: "m1", sessionId: "s1", prompt: "queued", delivery: "queue" })
    await inbox1.admit({ id: "m2", sessionId: "s1", prompt: "steered", delivery: "steer" })

    // New inbox constructed against the same store, simulating a restart.
    const inbox2 = new MemorySessionInput(store)
    await inbox2.hydrate()
    expect(await inbox2.hasPending("s1", "queue")).toBe(true)
    expect(await inbox2.hasPending("s1", "steer")).toBe(true)
    expect(await inbox2.promoteNextQueued("s1")).toBe(true)
  })

  it("records admittedSeq from the durable event seq", async () => {
    const store = new MemoryEventStore()
    const inbox = new MemorySessionInput(store)
    // First an unrelated event occupies seq 0.
    await store.append("s2", "Session.Created", { id: "s2", location: "/x", createdAt: 1 })
    const adm = await inbox.admit({ id: "m1", sessionId: "s1", prompt: "hi", delivery: "steer" })
    expect(adm.admittedSeq).toBe(0)
  })
})

describe("session replay", () => {
  it("rebuilds messages by folding durable events, deriving seq from the log", async () => {
    const store = new MemoryEventStore()
    await store.append("s1", "Session.Created", { id: "s1", location: "/proj", createdAt: 1 })
    await store.append("s1", "Session.MessageAppended", { sessionId: "s1", message: { kind: "user", id: "m1", seq: 0, text: "hello" } })

    const session = Session.replay(await store.read("s1"))
    expect(session.messages.length).toBe(1)
    expect(session.messages[0]!.kind).toBe("user")
    expect(session.messages[0]!.seq).toBe(1)
    expect(session.headSeq).toBe(1)
  })

  it("throws when the stream has no Session.Created event", () => {
    expect(() => Session.replay([])).toThrow()
  })

  it("projectMessage produces an event with the next durable seq", () => {
    const session = Session.create("s1", "/proj")
    const ev = session.projectMessage({ kind: "user", id: "m1", seq: 0, text: "hi" })
    expect(ev.type).toBe("Session.MessageAppended")
    expect((ev.data as { message: SessionMessage }).message.seq).toBe(0)
  })
})
