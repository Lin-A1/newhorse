import { expect, test } from "bun:test"
import { createOpencodeClient } from "../src/v2/client"

test("serializes every Memory SDK operation with Workspace routing", async () => {
  const requests: Array<{
    method: string
    path: string
    query: URLSearchParams
    directory?: string | null
    workspace?: string | null
    body?: unknown
  }> = []
  const client = createOpencodeClient({
    baseUrl: "http://memory.test",
    directory: "/work/project",
    experimental_workspaceID: "wrk_memory_sdk",
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.clone().text()
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        directory: request.headers.get("x-opencode-directory"),
        workspace: request.headers.get("x-opencode-workspace"),
        body: text ? JSON.parse(text) : undefined,
      })
      const body = url.pathname.endsWith("/export")
        ? []
        : url.pathname.endsWith("/clear")
          ? { cleared: 1 }
          : url.pathname === "/memory"
            ? { items: [] }
            : url.pathname.endsWith("/pause") || url.pathname.endsWith("/decision") || request.method === "PATCH"
              ? memory()
              : true
      return Response.json(body)
    },
  })

  const session = "ses_memory_sdk"
  await client.memory.list({ session, includeGlobal: "true", limit: "25", cursor: "mem_cursor" })
  await client.memory.update({
    session,
    memoryID: "mem_sdk",
    scope: "workspace",
    content: "updated",
    kind: "goal",
    expiresAt: 1_900_000_000_000,
  })
  await client.memory.decide({ session, memoryID: "mem_sdk", scope: "workspace", decision: "accept" })
  await client.memory.pause({ session, memoryID: "mem_sdk", scope: "workspace", paused: true })
  await client.memory.remove({ session, memoryID: "mem_sdk", scope: "workspace" })
  await client.memory.export({ session, includeGlobal: "true" })
  await client.memory.clear({ session, target: "workspace" })

  expect(requests.map((request) => [request.method, request.path])).toEqual([
    ["GET", "/memory"],
    ["PATCH", "/memory/mem_sdk"],
    ["POST", "/memory/mem_sdk/decision"],
    ["POST", "/memory/mem_sdk/pause"],
    ["DELETE", "/memory/mem_sdk"],
    ["GET", "/memory/export"],
    ["POST", "/memory/clear"],
  ])
  for (const request of requests) {
    expect(request.query.get("session")).toBe(session)
    expect(request.query.has("profileID")).toBe(false)
    if (request.method === "GET") {
      expect(request.query.get("workspace")).toBe("wrk_memory_sdk")
      expect(request.query.get("directory")).toBe("/work/project")
      continue
    }
    expect(request.workspace).toBe("wrk_memory_sdk")
    expect(request.directory).toBe(encodeURIComponent("/work/project"))
  }
  expect(requests[0]!.query.get("includeGlobal")).toBe("true")
  expect(requests[0]!.query.get("limit")).toBe("25")
  expect(requests[0]!.query.get("cursor")).toBe("mem_cursor")
  expect(requests[1]!.body).toEqual({
    scope: "workspace",
    content: "updated",
    kind: "goal",
    expiresAt: 1_900_000_000_000,
  })
  expect(requests[2]!.body).toEqual({ scope: "workspace", decision: "accept" })
  expect(requests[3]!.body).toEqual({ scope: "workspace", paused: true })
  expect(requests[6]!.body).toEqual({ target: "workspace" })
})

function memory() {
  return {
    id: "mem_sdk",
    workspaceID: "wrk_memory_sdk",
    scope: "workspace",
    kind: "goal",
    content: "updated",
    provenance: "user_confirmed",
    sensitivity: "normal",
    status: "active",
    timeCreated: 1_700_000_000_000,
    timeUpdated: 1_700_000_000_001,
  }
}
