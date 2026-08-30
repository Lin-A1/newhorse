import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApprovalHub } from "./approvals"
import { createScheduler, nextDue, validateCron } from "./scheduler"
import { aggregateUsage } from "./usage"
import type { SqliteEventStore as SqliteEventStoreType } from "@newhorse/core"

/**
 * Client-facing engine surfaces (S1): interactive approvals, scheduled
 * prompts (定时任务), usage aggregation, settings + models endpoints.
 */

describe("approval hub (interactive, fail-closed)", () => {
  it("parks a gate request, the client resolves it, the gate completes", async () => {
    const hub = createApprovalHub()
    const gatePromise = hub.gate({ id: "a1", kind: "command", target: "rm -rf /tmp/x", decision: "prompt" })
    expect(hub.pending().map((p) => p.id)).toEqual(["a1"])
    expect(hub.resolve("a1", true)).toBe(true)
    await expect(gatePromise).resolves.toBe(true)
    expect(hub.pending()).toEqual([])
  })

  it("auto-DENIES an unanswered request after the timeout (fail-closed)", async () => {
    const hub = createApprovalHub({ timeoutMs: 30 })
    const gatePromise = hub.gate({ id: "a2", kind: "path", target: "/etc/passwd", decision: "prompt" })
    await expect(gatePromise).resolves.toBe(false)
    expect(hub.resolve("a2", true)).toBe(false) // already settled
  })
})

describe("scheduler (定时任务)", () => {
  it("validates schedule inputs (exactly one cadence, prompt required)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-sched-"))
    try {
      const fired: string[] = []
      const s = createScheduler({ file: join(tmp, "schedules.json"), fire: async (sch) => {
        fired.push(sch.id)
      } })
      await expect(s.add({ sessionId: "x", prompt: "p", intervalMinutes: 5, dailyAt: "09:00" })).rejects.toThrow(/exactly one/)
      await expect(s.add({ sessionId: "x", prompt: "" })).rejects.toThrow(/prompt is required/)
      await expect(s.add({ sessionId: "x", prompt: "p", cron: "not a cron" })).rejects.toThrow(/5 fields/)
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("tick fires DUE schedules only, records the result, and persists across instances", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-sched-"))
    try {
      const fired: string[] = []
      const file = join(tmp, "schedules.json")
      const s = createScheduler({ file, fire: async () => {
        fired.push("fired")
      } })
      // intervalMinutes 1 → due as soon as one minute passes the creation instant.
      const created = await s.add({ sessionId: "sess", prompt: "check mail", intervalMinutes: 1 })
      // Force due by backdating createdAt in the file, then load a FRESH
      // instance (the first one has the pre-backdate rows cached in memory).
      const fs = await import("node:fs/promises")
      const rows = (JSON.parse(await fs.readFile(file, "utf8")) as { schedules: Array<{ createdAt: number }> }).schedules
      rows[0]!.createdAt = Date.now() - 600_000
      await fs.writeFile(file, JSON.stringify({ schedules: rows }))
      const s2 = createScheduler({ file, fire: async () => {
        fired.push("fired2")
      } })
      const fired1 = await s2.tick()
      expect(fired1).toEqual([created.id])
      // The run is recorded and visible to the same instance + a new one.
      expect((await s2.list())[0]?.lastResult).toBe("ok")
      const s3 = createScheduler({ file, fire: async () => {
        fired.push("fired3")
      } })
      expect((await s3.list())[0]?.lastResult).toBe("ok")
      // Not due again within the interval (lastRunAt just recorded).
      expect(await s2.tick(Date.now())).toEqual([])
      expect(fired).toEqual(["fired2"])
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("cron matcher: nextDue for daily-at and interval", () => {
    expect(validateCron("*/5 * * * *")).toBeUndefined()
    expect(() => validateCron("bad cron")).toThrow()
    const t = new Date("2026-06-15T10:00:00").getTime()
    expect(nextDue({ intervalMinutes: 30 }, t)).toBe(t + 30 * 60_000)
    const daily = nextDue({ dailyAt: "23:59" }, t)!
    expect(new Date(daily).getHours()).toBe(23)
    expect(new Date(daily).getMinutes()).toBe(59)
  })
})

describe("usage aggregation", () => {
  it("folds StepEnded usage into days with model attribution", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nh-usage-"))
    try {
      const db = new Database(join(tmp, "events.db"))
      const core = (await import("@newhorse/core")) as unknown as { SqliteEventStore: new (db: Database) => SqliteEventStoreType }
      const store = new core.SqliteEventStore(db)
      await store.append("s1", "Session.Created", { id: "s1", location: "/w", createdAt: Date.now() })
      await store.append("s1", "Session.MessageAppended", { sessionId: "s1", message: { kind: "assistant", id: "a", seq: 2, content: [{ type: "text", text: "hi" }], model: "MiniMax-M2" } })
      await store.append("s1", "Session.StepEnded", { sessionId: "s1", step: 1, finish: "stop", usage: { inputTokens: 100, outputTokens: 50 } })
      await store.append("s2", "Session.Created", { id: "s2", location: "/w", createdAt: Date.now() })
      await store.append("s2", "Session.StepEnded", { sessionId: "s2", step: 1, finish: "stop", usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 } })
      const summary = await aggregateUsage(join(tmp, "events.db"), 30)
      expect(summary.totals.inputTokens).toBe(110)
      expect(summary.totals.outputTokens).toBe(55)
      expect(summary.totals.steps).toBe(2)
      expect(summary.sessions).toBe(2)
      expect(summary.days).toHaveLength(1) // all created_at = now → today
      const today = summary.days[0]!
      expect(today.byModel["MiniMax-M2"]?.outputTokens).toBe(50)
      expect(today.byModel["unknown"]?.outputTokens).toBe(5)
      db.close()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("client endpoints (settings / models / approvals)", () => {
  it("settings: GET is redacted, PUT persists via the controller", async () => {
    let written: unknown
    const { createServer } = await import("../../server/src/server")
    const handle = await createServer({
      port: 0,
      settings: {
        get: () => ({ agentHome: "/h", dataDir: "/d", provider: { kind: "anthropic", baseUrl: "https://x", apiKey: "sk-secret-9999" }, model: "m", host: "127.0.0.1", port: 1, workspace: "/w", allowBash: false, allowPluginCode: false, approvalPolicy: "strict", memory: { on: false, extraction: false, vector: { enabled: false, mode: "auto", embedding: { kind: "minimax", baseUrl: "https://e", apiKey: "", model: "embo-01" } } } }),
        write: async (patch) => {
          written = patch
          return { agentHome: "/h", dataDir: "/d", provider: { kind: "openai", baseUrl: "https://y", apiKey: "sk-new-1" }, model: "new-model", host: "127.0.0.1", port: 1, workspace: "/w", allowBash: false, allowPluginCode: false, approvalPolicy: "strict", memory: { on: false, extraction: false, vector: { enabled: false, mode: "auto", embedding: { kind: "minimax", baseUrl: "https://e", apiKey: "", model: "embo-01" } } } }
        },
      },
    })
    const get = await (await fetch(`${handle.baseUrl}/v1/settings`)).json() as { provider: { hasApiKey: boolean; apiKeyHint?: string; apiKey?: string } }
    expect(get.provider.hasApiKey).toBe(true)
    expect(get.provider.apiKeyHint).toBe("…9999")
    expect((get.provider as { apiKey?: string }).apiKey).toBeUndefined()
    const put = await fetch(`${handle.baseUrl}/v1/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "new-model" }) })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { model: string }).model).toBe("new-model")
    expect(written).toEqual({ model: "new-model" })
    await handle.stop()
  })

  it("models: lists via the injectable fetch; failure degrades to empty", async () => {
    const fakeFetch = (async (url: string) => {
      if (String(url).endsWith("/v1/models")) return Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] }) as unknown as Response
      throw new Error("nope")
    }) as unknown as typeof globalThis.fetch
    const { createServer } = await import("../../server/src/server")
    const handle = await createServer({
      port: 0,
      modelsFetch: fakeFetch,
      settings: { get: () => ({ agentHome: "/h", dataDir: "/d", provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", host: "127.0.0.1", port: 1, workspace: "/w", allowBash: false, allowPluginCode: false, approvalPolicy: "strict", memory: { on: false, extraction: false, vector: { enabled: false, mode: "auto", embedding: { kind: "minimax", baseUrl: "https://e", apiKey: "", model: "e" } } } }), write: async () => { throw new Error("unused") } },
    })
    const res = await (await fetch(`${handle.baseUrl}/v1/models`)).json() as { models: string[] }
    expect(res.models).toEqual(["model-a", "model-b"])
    await handle.stop()
  })

  it("approvals endpoint: gate → pending → POST settle", async () => {
    const hub = createApprovalHub
    const h = hub()
    const { createServer } = await import("../../server/src/server")
    const handle = await createServer({ port: 0, approvals: h, sessionConfig: () => ({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace: "/w" }) })
    void h.gate({ id: "gate-1", kind: "command", target: "echo hi", decision: "prompt" })
    const pending = await (await fetch(`${handle.baseUrl}/v1/approvals`)).json() as { approvals: Array<{ id: string; target: string }> }
    expect(pending.approvals.map((p) => p.id)).toEqual(["gate-1"])
    const settle = await fetch(`${handle.baseUrl}/v1/approvals/gate-1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allow: false }) })
    expect(settle.status).toBe(200)
    expect(((await (await fetch(`${handle.baseUrl}/v1/approvals`)).json()) as { approvals: unknown[] }).approvals).toEqual([])
    await handle.stop()
  })

  it("schedules endpoints: create → list → run-now", async () => {
    const sched = createScheduler
    const tmp = await mkdtemp(join(tmpdir(), "nh-ep-"))
    try {
      const fired: string[] = []
      const s = sched({ file: join(tmp, "s.json"), fire: async (sch) => {
        fired.push(sch.sessionId)
      } })
      const { createServer } = await import("../../server/src/server")
    const handle = await createServer({ port: 0, schedules: s, sessionConfig: () => ({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace: "/w" }) })
      const created = await (await fetch(`${handle.baseUrl}/v1/schedules`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "target", prompt: "daily digest", dailyAt: "09:00" }) })).json() as { id: string; dailyAt?: string }
      expect(created.id).toBeTruthy()
      const list = await (await fetch(`${handle.baseUrl}/v1/schedules`)).json() as { schedules: Array<{ id: string }> }
      expect(list.schedules.map((x) => x.id)).toContain(created.id)
      const run = await fetch(`${handle.baseUrl}/v1/schedules/${created.id}/run`, { method: "POST" })
      expect(run.status).toBe(200)
      // The fire callback delivered to the target session.
      await new Promise((r) => setTimeout(r, 50))
      expect(fired).toEqual(["target"])
      await handle.stop()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })
})
