import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteSessionDirectory } from "./session-directory"

describe("SqliteSessionDirectory (cross-process seam)", () => {
  it("register/lookup/unregister round trip", () => {
    const dir = createSqliteSessionDirectory(":memory:")
    dir.register("s1", "http://127.0.0.1:4001")
    expect(dir.lookup("s1")?.endpoint).toBe("http://127.0.0.1:4001")
    expect(dir.lookup("s1")?.pid).toBe(process.pid)
    dir.unregister("s1")
    expect(dir.lookup("s1")).toBeUndefined()
  })

  it("register is an idempotent upsert that refreshes ownership and heartbeat", () => {
    const dir = createSqliteSessionDirectory(":memory:")
    dir.register("s1", "http://a:1")
    dir.register("s1", "http://a:1")
    dir.register("s1", "http://b:2", 999) // an owner change (re-created session) overwrites
    const e = dir.lookup("s1")!
    expect(e.endpoint).toBe("http://b:2")
    expect(e.pid).toBe(999)
  })

  it("two directory instances over one file see each other (the multi-process path)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-dir-"))
    try {
      const dbPath = join(tmp, "registry.db")
      const a = createSqliteSessionDirectory(dbPath)
      const b = createSqliteSessionDirectory(dbPath)
      a.register("owned-by-a", "http://127.0.0.1:4001")
      b.register("owned-by-b", "http://127.0.0.1:4002")
      // Each process resolves the other's sessions.
      expect(b.lookup("owned-by-a")?.endpoint).toBe("http://127.0.0.1:4001")
      expect(a.lookup("owned-by-b")?.endpoint).toBe("http://127.0.0.1:4002")
      a.close?.()
      b.close?.()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("heartbeat refreshes only the given endpoint's rows; sweep removes stale ones", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-dir-"))
    try {
      const dbPath = join(tmp, "registry.db")
      const a = createSqliteSessionDirectory(dbPath)
      const b = createSqliteSessionDirectory(dbPath)
      a.register("s-a", "http://a:1")
      b.register("s-b", "http://b:1")
      a.heartbeat("http://a:1")
      // Force staleness by writing an old heartbeat through a fresh connection.
      const stale = Date.now() - 60_000
      const raw = new Database(dbPath)
      raw.run("UPDATE session_live SET heartbeat_at = ? WHERE endpoint = 'http://b:1'", [stale])
      raw.close()
      const swept = b.sweep(30_000)
      expect(swept).toEqual(["s-b"]) // a's row survived its fresh heartbeat
      expect(a.lookup("s-a")).toBeDefined()
      expect(b.lookup("s-b")).toBeUndefined()
      a.close?.()
      b.close?.()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("entries lists the full directory", () => {
    const dir = createSqliteSessionDirectory(":memory:")
    dir.register("s2", "http://b:2")
    dir.register("s1", "http://a:1")
    expect(dir.entries().map((e) => e.sessionId)).toEqual(["s1", "s2"])
  })
})
