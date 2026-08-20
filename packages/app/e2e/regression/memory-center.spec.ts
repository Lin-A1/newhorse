import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import type { MemoryInfo } from "@newhorse/sdk/v2"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/MemoryCenter"
const workspaceID = "wrk_memory_center"
const sessionID = "ses_memory_center"
const now = 1_700_000_000_000

type MemoryRequest = {
  method: string
  path: string
  workspace?: string
  session?: string
  profileID?: string
  body?: Record<string, unknown>
}

for (const layout of ["legacy", "v2"] as const) {
  test(`manages every scoped Memory action in ${layout} settings`, async ({ page }) => {
    const requests: MemoryRequest[] = []
    let records = [
      memory("mem_accept", "Saved preference", "active", "project", {
        provenance: "model_inferred",
        sourceMessageID: "msg_memory_source",
      }),
      memory("mem_reject", "Second saved fact", "active", "project", { provenance: "model_inferred" }),
      memory("mem_active", "Active goal", "active", "project", { kind: "goal" }),
      memory("mem_delete", "Delete me", "active", "project"),
      memory("mem_relationship", "Relationship note", "active", "relationship", { kind: "relationship" }),
      memory("mem_global", "Global preference", "active", "user_global"),
    ]

    await installMock(
      page,
      () => records,
      (next) => (records = next),
      requests,
    )
    await page.addInitScript(
      ({ enabled }) => {
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({ general: { newLayoutDesigns: enabled, layoutTransitionEligible: true } }),
        )
        localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      },
      { enabled: layout === "v2" },
    )
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

    if (layout === "legacy") {
      await page.getByRole("button", { name: "Settings" }).click()
    } else {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
    }
    const settings = page.locator(layout === "legacy" ? ".settings-dialog" : ".settings-v2-dialog")
    await expect(settings).toBeVisible()
    await settings.getByRole("tab", { name: "Memory Center" }).click()

    const saved = settings.locator('[data-memory-id="mem_accept"]')
    await expect(saved).toContainText("Saved preference")
    await expect(saved).toContainText("message msg_memory_source")
    await expect(settings.locator('[data-memory-id="mem_global"]')).toHaveCount(0)
    await settings.getByRole("radio", { name: "Global memory" }).click()
    await expect(settings.locator('[data-memory-id="mem_global"]')).toBeVisible()
    await expect(settings.locator('[data-memory-id="mem_accept"]')).toHaveCount(0)
    await settings.getByRole("radio", { name: "Workspace memory" }).click()

    const other = settings.locator('[data-memory-id="mem_reject"]')
    await expect(other).toContainText("Second saved fact")

    const active = settings.locator('[data-memory-id="mem_active"]')
    await active.getByRole("button", { name: "Edit" }).click()
    await active.getByRole("textbox", { name: "Memory content" }).fill("Updated goal")
    await active.getByRole("button", { name: "Memory kind" }).click()
    await page.locator('[data-slot="select-select-item"]').filter({ hasText: "summary" }).click()
    await active.getByRole("textbox", { name: "Memory expiry" }).fill("2030-01-02T03:04")
    await active.getByRole("button", { name: "Save" }).click()
    await expect(active).toContainText("Updated goal")
    await active.getByRole("button", { name: "Pause" }).click()
    await expect(active).toContainText("paused")
    await active.getByRole("button", { name: "Resume" }).click()
    await expect(active).toContainText("active")

    const download = page.waitForEvent("download")
    await settings.getByRole("button", { name: "Export" }).click()
    expect((await download).suggestedFilename()).toMatch(/newhorse-memory-.*\.json/)

    await settings.locator('[data-memory-id="mem_delete"]').getByRole("button", { name: "Delete" }).click()
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(settings.locator('[data-memory-id="mem_delete"]')).toHaveCount(0)

    await settings.getByRole("button", { name: "Reset relationship" }).click()
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(settings.locator('[data-memory-id="mem_relationship"]')).toHaveCount(0)

    await settings.getByRole("button", { name: "Clear global preferences" }).click()
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(settings.locator('[data-memory-id="mem_global"]')).toHaveCount(0)

    await settings.getByRole("button", { name: "Clear workspace" }).click()
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(settings.getByText("No Memory records.")).toBeVisible()

    expect(requests).toEqual(
      expect.arrayContaining([
        mutation("/memory/mem_active", {
          scope: "project",
          content: "Updated goal",
          kind: "summary",
          expiresAt: new Date("2030-01-02T03:04").getTime(),
        }),
        mutation("/memory/mem_active/pause", { scope: "project", paused: true }),
        mutation("/memory/mem_active/pause", { scope: "project", paused: false }),
        expect.objectContaining({
          path: "/memory/mem_delete",
          workspace: workspaceID,
          session: sessionID,
          method: "DELETE",
        }),
        mutation("/memory/clear", { target: "relationship" }),
        mutation("/memory/clear", { target: "user_global" }),
        mutation("/memory/clear", { target: "workspace" }),
      ]),
    )
    expect(requests.filter((request) => request.path.startsWith("/memory"))).not.toHaveLength(0)
    expect(
      requests.every(
        (request) =>
          !request.path.startsWith("/memory") || (request.session === sessionID && request.profileID === undefined),
      ),
    ).toBe(true)
  })
}

test("loads additional Memory pages", async ({ page }) => {
  let requests = 0
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [session()],
    capability: personalCapability(),
    pageMessages: () => ({ items: [] }),
    memory: {
      list: () => {
        requests += 1
        return requests === 1
          ? { items: [memory("mem_first", "First page", "active", "project")], nextCursor: "mem_cursor" }
          : { items: [memory("mem_second", "Second page", "active", "project")] }
      },
      aggregate: () => [memory("mem_first", "First page", "active", "project")],
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true, layoutTransitionEligible: true } }),
    )
    localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Memory Center" }).click()
  await expect(settings.getByText("First page")).toBeVisible()
  await settings.getByRole("button", { name: "Load more" }).click()
  await expect(settings.getByText("Second page")).toBeVisible()
  expect(requests).toBe(2)
})

test("discards an in-flight Memory page after switching Sessions", async ({ page }) => {
  const switchedSessionID = "ses_memory_switched"
  const switchedSession = { ...session(), id: switchedSessionID, slug: switchedSessionID, title: "Switched Memory" }
  let releasePage!: () => void
  const pageReady = new Promise<void>((resolve) => (releasePage = resolve))
  let markPageRequested!: () => void
  const pageRequested = new Promise<void>((resolve) => (markPageRequested = resolve))

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [session(), switchedSession],
    capability: personalCapability(),
    pageMessages: () => ({ items: [] }),
    memory: {
      list: async (query) => {
        const requestedSession = query.get("session")
        if (requestedSession === switchedSessionID)
          return { items: [memory("mem_switched", "Switched Session Memory", "active", "project")] }
        if (query.get("cursor")) {
          markPageRequested()
          await pageReady
          return {
            items: [memory("mem_stale_page", "Stale paginated Memory", "active", "project")],
            nextCursor: "stale_cursor",
          }
        }
        return {
          items: [memory("mem_page_source", "Original Session Memory", "active", "project")],
          nextCursor: "page_cursor",
        }
      },
      aggregate: () => [],
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true, layoutTransitionEligible: true } }),
    )
    localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Memory Center" }).click()
  await expect(settings.getByText("Original Session Memory")).toBeVisible()

  await settings.getByRole("button", { name: "Load more" }).click()
  await pageRequested
  await navigate(page, switchedSessionID)

  const staleResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === "/memory" && url.searchParams.get("cursor") === "page_cursor"
  })
  releasePage()
  const response = await staleResponse
  await response.finished()
  await expect(settings.getByText("Stale paginated Memory")).toHaveCount(0)
  await expect(settings.getByText("Switched Session Memory")).toBeVisible()

  await expect(settings.getByText("Original Session Memory")).toHaveCount(0)
  await expect(settings.getByText("Stale paginated Memory")).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Load more" })).toHaveCount(0)
})

test("waits for Session metadata after a route change before loading Memory", async ({ page }) => {
  const delayedSessionID = "ses_memory_delayed"
  const delayedSession = { ...session(), id: delayedSessionID, slug: delayedSessionID, title: "Delayed Memory" }
  let releaseSession!: () => void
  const sessionReady = new Promise<void>((resolve) => (releaseSession = resolve))
  const requests: MemoryRequest[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [session(), delayedSession],
    listSessions: () => [session()],
    capability: personalCapability(),
    pageMessages: () => ({ items: [] }),
    beforeSessionResponse: ({ sessionID: requested }) =>
      requested === delayedSessionID ? sessionReady : Promise.resolve(),
    memory: {
      list: (query) => {
        requests.push(memoryRequest("GET", "/memory", query))
        return {
          items: [
            memory(
              query.get("session") === delayedSessionID ? "mem_delayed" : "mem_initial",
              query.get("session") === delayedSessionID ? "Trusted Session Memory" : "Initial Session Memory",
              "active",
              "project",
            ),
          ],
        }
      },
      aggregate: () => [],
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true, layoutTransitionEligible: true } }),
    )
    localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Memory Center" }).click()
  await expect(settings.getByText("Initial Session Memory")).toBeVisible()
  requests.length = 0

  await navigate(page, delayedSessionID)

  expect(requests).toEqual([])

  releaseSession()
  await expect(settings.getByText("Trusted Session Memory")).toBeVisible()
  expect(requests).toEqual([
    expect.objectContaining({ method: "GET", path: "/memory", session: delayedSessionID, profileID: undefined }),
  ])
})

async function installMock(
  page: Parameters<typeof mockOpenCodeServer>[0],
  getRecords: () => MemoryInfo[],
  setRecords: (records: MemoryInfo[]) => void,
  requests: MemoryRequest[],
) {
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [session()],
    capability: personalCapability(),
    pageMessages: () => ({ items: [] }),
    memory: {
      list: (query) => {
        requests.push(memoryRequest("GET", "/memory", query))
        return { items: getRecords() }
      },
      aggregate: () => getRecords(),
      export: (query) => {
        requests.push(memoryRequest("GET", "/memory/export", query))
        return getRecords()
      },
      mutate: ({ method, path, query, body }) => {
        requests.push(memoryRequest(method, path, query, body as Record<string, unknown> | undefined))
        let records = getRecords()
        if (path === "/memory/clear") {
          const target = (body as { target: string }).target
          records = records.filter((item) =>
            target === "user_global"
              ? item.scope !== "user_global"
              : target === "relationship"
                ? item.scope !== "relationship"
                : item.scope === "user_global",
          )
          setRecords(records)
          return { cleared: 1 }
        }
        const id = path.split("/")[2]!
        const index = records.findIndex((item) => item.id === id)
        if (method === "DELETE") {
          setRecords(records.filter((item) => item.id !== id))
          return true
        }
        const item = records[index]!
        if (path.endsWith("/decision")) {
          const decision = (body as { decision: "accept" | "reject" }).decision
          records[index] = {
            ...item,
            status: decision === "accept" ? "active" : "rejected",
            provenance: decision === "accept" ? "user_confirmed" : item.provenance,
          }
        } else if (path.endsWith("/pause")) {
          records[index] = { ...item, status: (body as { paused: boolean }).paused ? "paused" : "active" }
        } else {
          records[index] = { ...item, ...(body as object), timeUpdated: now + 1 }
        }
        setRecords(records)
        return records[index]
      },
    },
  })
}

function memoryRequest(
  method: string,
  path: string,
  query: URLSearchParams,
  body?: Record<string, unknown>,
): MemoryRequest {
  return {
    method,
    path,
    workspace: query.get("workspace") ?? undefined,
    session: query.get("session") ?? undefined,
    profileID: query.get("profileID") ?? undefined,
    body,
  }
}

function mutation(path: string, body: Record<string, unknown>) {
  return expect.objectContaining({
    path,
    workspace: workspaceID,
    session: sessionID,
    profileID: undefined,
    body: expect.objectContaining(body),
  })
}

async function navigate(page: Parameters<typeof mockOpenCodeServer>[0], sessionID: string) {
  await page.evaluate((nextSessionID) => {
    const current = new URL(location.href)
    current.pathname = current.pathname.replace(/\/session\/[^/]+$/, `/session/${nextSessionID}`)
    history.pushState({}, "", current)
    dispatchEvent(new PopStateEvent("popstate"))
  }, sessionID)
}

function personalCapability() {
  return {
    profile: { id: "companion", kind: "companion", name: "Companion", memory: "ask", proactive: false },
    workspace: { id: workspaceID, kind: "personal", contentScope: "personal", source: "metadata" },
    agent: { default: "build", current: "build", items: [{ name: "build", mode: "primary" }] },
    tools: [],
    mcp: [],
    skills: [],
    plugins: { loaded: 0 },
    memory: { policy: "ask", records: 6, availability: { available: true } },
    reminders: { proactive: false, paused: false, scheduled: 0, availability: { available: false } },
  }
}

function project() {
  return {
    id: "proj_memory_center",
    worktree: directory,
    vcs: "git",
    name: "memory-center",
    time: { created: now, updated: now },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "proj_memory_center",
    directory,
    workspaceID,
    profileID: "companion",
    title: "Memory Center",
    version: "dev",
    time: { created: now, updated: now },
  }
}

function memory(
  id: string,
  content: string,
  status: MemoryInfo["status"],
  scope: MemoryInfo["scope"],
  input: Partial<Pick<MemoryInfo, "kind" | "provenance" | "sourceMessageID">> = {},
): MemoryInfo {
  return {
    id,
    workspaceID: scope === "user_global" ? undefined : workspaceID,
    profileID: scope === "user_global" ? undefined : "companion",
    scope,
    kind: input.kind ?? "preference",
    content,
    provenance: input.provenance ?? "user_explicit",
    sensitivity: "normal",
    status,
    sourceMessageID: input.sourceMessageID,
    timeCreated: now,
    timeUpdated: now,
  }
}
