import { Database } from "bun:sqlite"

/**
 * SessionDirectory seam — the CROSS-PROCESS half of the SessionManager (M4).
 *
 * The in-process hub (hub.ts) already routes interrupt/send to live sessions
 * through an in-memory Map; that map dies with the process and is invisible to
 * sibling processes. The directory is the shared, durable side: every server
 * process registers the sessions it OWNS into one SQLite file (WAL, so
 * multiple processes can read/write concurrently), and a process asked to act
 * on a session it does not own looks the owner up here and proxies over HTTP.
 *
 * Ownership invariant: a row's `endpoint` is written ONLY by the owning
 * process at register time. A proxy therefore always travels owner-ward and
 * the owner either serves locally or 404s/sweeps — proxy cycles cannot form.
 * Liveness is heartbeat-based (`heartbeat_at`, refreshed per endpoint), and
 * `sweep` removes rows whose owner stopped heartbeating (crash / kill -9), so
 * the directory self-heals instead of routing into the void.
 *
 * Deliberately OUT of scope (still honest M4 boundaries): cross-process spawn
 * (a child is driven by the process that created it — but it IS registered, so
 * any process can interrupt/steer/observe it), and cross-process event
 * streaming beyond the prompt SSE relay.
 */

export interface DirectoryEntry {
  readonly sessionId: string
  /** Base URL of the owning server (e.g. http://127.0.0.1:3927). */
  readonly endpoint: string
  readonly pid: number
  readonly heartbeatAt: number
}

export interface SessionDirectory {
  /** Upsert ownership of a live session (idempotent; refreshes the heartbeat). */
  readonly register: (sessionId: string, endpoint: string, pid?: number) => void
  readonly unregister: (sessionId: string) => void
  readonly lookup: (sessionId: string) => DirectoryEntry | undefined
  /** Refresh the heartbeat for EVERY row of one endpoint (a server's own liveness tick). */
  readonly heartbeat: (endpoint: string) => void
  /** Delete rows whose heartbeat is older than maxAgeMs; returns swept session ids. */
  readonly sweep: (maxAgeMs: number) => string[]
  /** All rows (observability / listing for hosts). */
  readonly entries: () => DirectoryEntry[]
  readonly close?: () => void
}

/** SQLite-backed directory over one shared file. WAL + busy_timeout so several
 *  server processes can register/sweep the same file concurrently. */
export function createSqliteSessionDirectory(dbPath: string): SessionDirectory {
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run(`CREATE TABLE IF NOT EXISTS session_live (
    session_id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    pid INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  )`)
  return {
    register(sessionId, endpoint, pid = process.pid) {
      db.run(
        `INSERT INTO session_live (session_id, endpoint, pid, heartbeat_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET endpoint = excluded.endpoint, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at`,
        [sessionId, endpoint, pid, Date.now()],
      )
    },
    unregister(sessionId) {
      db.run("DELETE FROM session_live WHERE session_id = ?", [sessionId])
    },
    lookup(sessionId) {
      const row = db.query("SELECT session_id, endpoint, pid, heartbeat_at FROM session_live WHERE session_id = ?").get(sessionId) as { session_id: string; endpoint: string; pid: number; heartbeat_at: number } | null
      return row ? { sessionId: row.session_id, endpoint: row.endpoint, pid: row.pid, heartbeatAt: row.heartbeat_at } : undefined
    },
    heartbeat(endpoint) {
      db.run("UPDATE session_live SET heartbeat_at = ? WHERE endpoint = ?", [Date.now(), endpoint])
    },
    sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs
      const dead = db.query("DELETE FROM session_live WHERE heartbeat_at < ? RETURNING session_id").all(cutoff) as { session_id: string }[]
      return dead.map((r) => r.session_id)
    },
    entries() {
      const rows = db.query("SELECT session_id, endpoint, pid, heartbeat_at FROM session_live ORDER BY session_id").all() as { session_id: string; endpoint: string; pid: number; heartbeat_at: number }[]
      return rows.map((r) => ({ sessionId: r.session_id, endpoint: r.endpoint, pid: r.pid, heartbeatAt: r.heartbeat_at }))
    },
    close() {
      db.close()
    },
  }
}
