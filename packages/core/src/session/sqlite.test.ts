import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { SqliteEventStore } from "./sqlite"
import { MemorySessionInput } from "./input"
import { Session } from "./session"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

function tmpDb(): string {
  return join(tmpdir(), `nh-events-${crypto.randomUUID()}.db`)
}

describe("sqlite event store", () => {
  it("persists and re-reads events across store instances (restart)", async () => {
    const path = tmpDb()
    try {
      const db1 = new Database(path)
      const store1 = new SqliteEventStore(db1)
      await store1.append("s1", "Session.Created", { id: "s1", location: "/p", createdAt: 1 })
      await store1.append("s1", "Session.MessageAppended", { sessionId: "s1", message: { kind: "user", id: "m1", seq: 0, text: "hi" } })
      db1.close()

      // Simulate a restart: a fresh store against the same file.
      const db2 = new Database(path)
      const store2 = new SqliteEventStore(db2)
      const events = await store2.read("s1")
      expect(events.length).toBe(2)
      expect(events[1]!.type).toBe("Session.MessageAppended")
      expect(await store2.latestSeq("s1")).toBe(1)
      // Hand off the store to the session layer to confirm replay works.
      const session = Session.replay(events)
      expect(session.messages.length).toBe(1)
      db2.close()
    } finally {
      await rm(path, { force: true }).catch(() => {})
    }
  })

  it("allocates collision-free sequences across concurrent appends", async () => {
    const store = new SqliteEventStore(new Database(":memory:"))
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.append("agg", "E", { i: 1 })),
    )
    const seqs = results.map((r) => r.seq)
    const unique = new Set(seqs)
    expect(unique.size).toBe(20)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it("hydrates the admission inbox from persisted log after restart", async () => {
    const path = tmpDb()
    try {
      const db1 = new Database(path)
      const store1 = new SqliteEventStore(db1)
      const inbox1 = new MemorySessionInput(store1)
      await inbox1.admit({ id: "m1", sessionId: "s1", prompt: "queued", delivery: "queue" })
      db1.close()

      const db2 = new Database(path)
      const store2 = new SqliteEventStore(db2)
      const inbox2 = new MemorySessionInput(store2)
      await inbox2.hydrate()
      expect(await inbox2.hasPending("s1", "queue")).toBe(true)
      db2.close()
    } finally {
      await rm(path, { force: true }).catch(() => {})
    }
  })

  it("migrates a legacy event table that predates the aggregate column", async () => {
    const path = tmpDb()
    try {
      // Build a DB using the legacy 4-column schema (no aggregate column).
      const legacy = new Database(path)
      legacy.run(`
        CREATE TABLE event (
          aggregate_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (aggregate_id, seq)
        )
      `)
      legacy.run("INSERT INTO event (aggregate_id, seq, type, data) VALUES ('old', 0, 'Session.Created', '{\"id\":\"old\"}')")
      legacy.close()

      // Opening it through the store must migrate (ADD COLUMN) and stay usable.
      const db = new Database(path)
      const store = new SqliteEventStore(db)
      const events = await store.read("old")
      expect(events.length).toBe(1)
      expect(events[0]!.aggregate).toBe("session")
      await store.append("old", "E", { i: 1 })
      expect((await store.read("old")).length).toBe(2)
      db.close()
    } finally {
      await rm(path, { force: true }).catch(() => {})
    }
  })
})
