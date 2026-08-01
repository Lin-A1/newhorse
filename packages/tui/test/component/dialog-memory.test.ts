import { describe, expect, test } from "bun:test"
import { createOpencodeClient, type MemoryInfo } from "@newhorse/sdk/v2"
import {
  memoryClear,
  memoryClearTargets,
  memoryDecide,
  memoryDetails,
  memoryPause,
  memoryRemove,
  memoryUpdate,
  mergeMemoryPage,
  parseExpiry,
} from "../../src/component/dialog-memory-state"

const record = (id: string, content = id): MemoryInfo => ({
  id,
  scope: "workspace",
  kind: "preference",
  content,
  provenance: "model_inferred",
  sensitivity: "normal",
  status: "proposed",
  sourceMessageID: "msg_source",
  timeCreated: 1,
  timeUpdated: 1,
})

describe("dialog Memory state", () => {
  test("formats source, scope, provenance and expiry details", () => {
    expect(memoryDetails({ ...record("mem_1"), timeExpires: Date.parse("2030-01-02T03:04:00Z") })).toEqual([
      "preference · workspace · model inferred",
      "message msg_source",
      "expires 2030-01-02T03:04:00.000Z",
    ])
  })

  test("appends pages while replacing duplicate records", () => {
    expect(mergeMemoryPage([record("mem_1", "old")], [record("mem_1", "new"), record("mem_2")])).toEqual([
      record("mem_1", "new"),
      record("mem_2"),
    ])
  })

  test("offers relationship reset only in Personal scope", () => {
    expect(memoryClearTargets(false)).toEqual(["workspace", "user_global"])
    expect(memoryClearTargets(true)).toEqual(["workspace", "relationship", "user_global"])
  })

  test("sends complete lifecycle mutation payloads", async () => {
    const requests: Array<{ method: string; path: string; query: string; body?: unknown }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body: request.method === "DELETE" ? undefined : await request.clone().json(),
      })
      return Response.json(new URL(request.url).pathname === "/memory/clear" ? { cleared: 1 } : record("mem_1"))
    }) as typeof globalThis.fetch
    const client = createOpencodeClient({
      baseUrl: "http://memory.test",
      fetch,
    })
    const item = record("mem_1")

    const routing = { session: "ses_memory" }
    await memoryDecide(client, routing, item, "accept")
    await memoryPause(client, routing, item, true)
    await memoryUpdate(client, routing, item, { content: "updated", kind: "summary", expiresAt: null })
    await memoryRemove(client, routing, item)
    await memoryClear(client, routing, "relationship")

    expect(requests).toEqual([
      {
        method: "POST",
        path: "/memory/mem_1/decision",
        query: "?session=ses_memory",
        body: { scope: "workspace", decision: "accept" },
      },
      {
        method: "POST",
        path: "/memory/mem_1/pause",
        query: "?session=ses_memory",
        body: { scope: "workspace", paused: true },
      },
      {
        method: "PATCH",
        path: "/memory/mem_1",
        query: "?session=ses_memory",
        body: { scope: "workspace", content: "updated", kind: "summary", clearExpiry: true },
      },
      { method: "DELETE", path: "/memory/mem_1", query: "?session=ses_memory&scope=workspace", body: undefined },
      {
        method: "POST",
        path: "/memory/clear",
        query: "?session=ses_memory",
        body: { target: "relationship" },
      },
    ])
    expect(requests.every((request) => !request.query.includes("profileID"))).toBe(true)
  })

  test("rejects SDK mutation responses without data", async () => {
    const failed = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ _tag: "BadRequest" }, { status: 400 })) as typeof globalThis.fetch
    const client = createOpencodeClient({
      baseUrl: "http://memory.test",
      fetch: failed,
    })
    await expect(memoryPause(client, {}, record("mem_1"), true)).rejects.toThrow("Memory pause failed")
  })

  test("parses ISO expiry and treats blank as clear", () => {
    expect(parseExpiry(" ")).toBeNull()
    expect(parseExpiry("2030-01-02T03:04:00Z")).toBe(Date.parse("2030-01-02T03:04:00Z"))
    expect(() => parseExpiry("tomorrow-ish")).toThrow("ISO date/time")
  })
})
