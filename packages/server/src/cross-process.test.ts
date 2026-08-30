import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type ServerHandle } from "./server"
import { createApp } from "@newhorse/runtime"
import { createSqliteSessionDirectory } from "@newhorse/runtime"
import type { Fetcher } from "@newhorse/llm"

/**
 * Cross-process SessionManager (M4): two REAL server instances on distinct
 * ports sharing ONE SQLite directory file. Every cross-op below travels the
 * same path production uses — HTTP proxy to the owning process — no mocks.
 */

/** A fetch that hangs until aborted (so interrupt/steer have a live target). */
function hangFetcher(): Fetcher {
  return (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
  })
}

/** A fetch returning a minimal completed SSE turn. */
function doneFetcher(): Fetcher {
  return async () => new Response(
    "data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n" + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

const provider = { kind: "openai" as const, baseUrl: "https://x", apiKey: "k" }

async function startServer(directory: ReturnType<typeof createSqliteSessionDirectory>, fetcher: Fetcher): Promise<ServerHandle> {
  return createServer({
    port: 0,
    directory,
    // The server pins the sessionId itself when it builds the App.
    sessionConfig: () => ({ provider, model: "m", workspace: "G:/proj", fetch: fetcher }),
  })
}

describe("cross-process SessionManager (two servers, one directory)", () => {
  it("a sibling process can observe, steer, and interrupt a session it does not own", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-xp-"))
    const registry = join(tmp, "registry.db")
    try {
      const dir = createSqliteSessionDirectory(registry)
      const a = await startServer(dir, hangFetcher())
      const b = await startServer(dir, doneFetcher())

      // Create a session on A (it registers A's endpoint in the directory).
      const created = await fetch(`${a.baseUrl}/v1/session`, { method: "POST", body: JSON.stringify({ sessionId: "xp-1" }) })
      expect(created.status).toBe(201)

      // B does NOT know xp-1 locally — the snapshot is proxied from A.
      const snap = await fetch(`${b.baseUrl}/v1/session/xp-1`)
      expect(snap.status).toBe(200)
      expect(((await snap.json()) as { id: string }).id).toBe("xp-1")

      // Start a live (hung) run on A, then STEER it from B.
      const promptRes = await fetch(`${a.baseUrl}/v1/session/xp-1/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "long task" }) })
      void promptRes // SSE consumed lazily; the run hangs in the LLM call
      await new Promise((r) => setTimeout(r, 150))
      const steer = await fetch(`${b.baseUrl}/v1/session/xp-1/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "focus on part 2" }) })
      expect(steer.status).toBe(200)

      // INTERRUPT from B: A's hung run must settle as interrupted.
      const interrupt = await fetch(`${b.baseUrl}/v1/session/xp-1/interrupt`, { method: "POST" })
      expect(interrupt.status).toBe(200)
      await new Promise((r) => setTimeout(r, 300))
      const events = await fetch(`${b.baseUrl}/v1/session/xp-1/events`) // proxied read of A's log
      const log = (await events.json()) as { type: string; data: Record<string, unknown> }[]
      expect(log.some((e) => e.type === "Session.PromptAdmitted" && (e.data.prompt as string)?.includes("focus on part 2"))).toBe(true)
      // The interrupted run's durable settle marker is Session.Interrupted.
      expect(log.some((e) => e.type === "Session.Interrupted")).toBe(true)

      // Directory shows ownership by A's endpoint.
      const live = await fetch(`${b.baseUrl}/v1/live`)
      const liveBody = (await live.json()) as { self: string; live: { sessionId: string; endpoint: string }[] }
      expect(liveBody.live.find((e) => e.sessionId === "xp-1")?.endpoint).toBe(a.baseUrl)

      await a.stop()
      await b.stop()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("cross-process creation is refused with 409 (split-brain guard)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-xp-"))
    try {
      const dir = createSqliteSessionDirectory(join(tmp, "registry.db"))
      const a = await startServer(dir, doneFetcher())
      const b = await startServer(dir, doneFetcher())
      await fetch(`${a.baseUrl}/v1/session`, { method: "POST", body: JSON.stringify({ sessionId: "owned" }) })
      const conflict = await fetch(`${b.baseUrl}/v1/session`, { method: "POST", body: JSON.stringify({ sessionId: "owned" }) })
      expect(conflict.status).toBe(409)
      await a.stop()
      await b.stop()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("a dead owner is reported honestly (502) and its stale entry is swept", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-xp-"))
    try {
      const dir = createSqliteSessionDirectory(join(tmp, "registry.db"))
      const a = await startServer(dir, doneFetcher())
      await fetch(`${a.baseUrl}/v1/session`, { method: "POST", body: JSON.stringify({ sessionId: "doomed" }) })
      const b = await startServer(dir, doneFetcher())
      await a.stop() // owner dies (stop unregisters its OWN rows...)
      // ...but a stale row (crash without cleanup) is what sweep exists for:
      dir.register("crashed", a.baseUrl) // points at the now-dead endpoint
      const res = await fetch(`${b.baseUrl}/v1/session/crashed`)
      expect(res.status).toBe(502)
      expect(dir.lookup("crashed")).toBeUndefined() // swept on failed proxy
      await b.stop()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("a stale self-entry is swept and reported missing (no self-proxy)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-xp-"))
    try {
      const dir = createSqliteSessionDirectory(join(tmp, "registry.db"))
      const b = await startServer(dir, doneFetcher())
      dir.register("ghost", b.baseUrl) // claims B owns it, but B has no App
      const res = await fetch(`${b.baseUrl}/v1/session/ghost`)
      expect(res.status).toBe(404)
      expect(dir.lookup("ghost")).toBeUndefined()
      await b.stop()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// Re-attach sanity: the resolver still works when a directory is absent.
describe("server SessionResolver (pluggable session routing)", () => {
  it("falls back to the resolver on a cache miss (lazy re-attach)", async () => {
    const handle = await createServer({
      port: 0,
      sessionResolver: async (id) => createApp({ provider, model: "m", sessionId: id, workspace: "G:/w", fetch: doneFetcher() }),
    })
    const snap = await fetch(`${handle.baseUrl}/v1/session/lazy-1`)
    expect(snap.status).toBe(200)
    expect(((await snap.json()) as { id: string }).id).toBe("lazy-1")
    await handle.stop()
  })
})
