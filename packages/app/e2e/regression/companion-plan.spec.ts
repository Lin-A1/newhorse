import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import type { MemoryInfo } from "@newhorse/sdk/v2"
import type { ContinuityGrantListResponse, ReminderListResponses } from "@newhorse/sdk/v2"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/CompanionPlan"
const workspaceID = "wrk_companion_plan"
const sessionID = "ses_companion_plan"
const now = Date.parse("2030-01-01T09:00:00Z")

type Reminder = ReminderListResponses[200][number]
type Grant = ContinuityGrantListResponse[number]
type PlanRequest = {
  method: string
  path: string
  workspace?: string
  session?: string
  profileID?: string
}

test("reviews and acts on Memory, Reminders, and Continuity grants in legacy settings", async ({ page }) => {
  const requests: PlanRequest[] = []
  let proposals = [
    memory("mem_accept", "Proposal to accept", "proposed"),
    memory("mem_reject", "Proposal to reject", "proposed"),
    memory("mem_active", "Already active", "active"),
  ]
  let reminders = [reminder("sch_daily", "Daily review", "pending", { recurrenceRule: "FREQ=DAILY;INTERVAL=1" })]
  let grants = [
    grant("cgr_workflow", "proposed"),
    grant("cgr_expired", "proposed", { purpose: "Stale handoff", timeExpires: Date.now() - 1 }),
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [session()],
    capability: capability(),
    pageMessages: () => ({ items: [] }),
    memory: {
      list: (query) => {
        requests.push(request("GET", "/memory", query))
        return { items: proposals }
      },
      mutate: ({ method, path, query, body }) => {
        requests.push(request(method, path, query, body as Record<string, unknown> | undefined))
        const id = path.split("/")[2]!
        const index = proposals.findIndex((item) => item.id === id)
        if (index < 0) return proposals[index]
        const decision = (body as { decision: "accept" | "reject" }).decision
        proposals[index] = {
          ...proposals[index]!,
          status: decision === "accept" ? "active" : "rejected",
          provenance: decision === "accept" ? "user_confirmed" : "model_inferred",
        }
        return proposals[index]
      },
    },
    reminder: {
      list: (query) => {
        requests.push(request("GET", "/reminder", query))
        return reminders
      },
      mutate: ({ method, path, query, body }) => {
        requests.push(request(method, path, query, body as Record<string, unknown> | undefined))
        const id = path.split("/")[2]!
        if (method === "DELETE") {
          reminders = reminders.filter((item) => item.id !== id)
          return true
        }
        const index = reminders.findIndex((item) => item.id === id)
        const paused = (body as { paused?: boolean }).paused
        reminders[index] = { ...reminders[index]!, status: paused ? "paused" : "pending", timeUpdated: now + 1 }
        return reminders[index]
      },
    },
    continuityGrant: {
      list: (query, headers) => {
        requests.push(request("GET", "/continuity-grant", query, undefined, headers))
        return grants
      },
      mutate: ({ action, grantID, query, headers }) => {
        requests.push(request("POST", `/continuity-grant/${grantID}/${action}`, query, undefined, headers))
        const index = grants.findIndex((item) => item.id === grantID)
        const item = grants[index]!
        const updated: Grant = {
          ...item,
          status: action === "approve" ? "active" : "revoked",
          ...(action === "approve" ? { timeApproved: now + 1 } : { timeRevoked: now + 2 }),
          timeUpdated: now + 2,
        }
        grants[index] = updated
        return updated
      },
    },
  })
  await page.addInitScript(
    ({ enabled }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: enabled, layoutTransitionEligible: true } }),
      )
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
    },
    { enabled: false },
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const forbiddenRequests: string[] = []
  let monitor = false
  page.on("request", (networkRequest) => {
    if (!monitor) return
    const path = new URL(networkRequest.url()).pathname
    if (
      path === `/session/${sessionID}/message` ||
      path === `/session/${sessionID}/diff` ||
      path === "/vcs/diff" ||
      path === "/file" ||
      path === "/file/content" ||
      path.startsWith("/find/")
    )
      forbiddenRequests.push(path)
  })

  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-dialog")
  await expect(settings).toBeVisible()
  monitor = true
  await settings.getByRole("tab", { name: "Companion Plan" }).click()

  // No auto-persist on load: only list reads so far.
  expect(requests.filter((item) => item.method !== "GET")).toEqual([])

  const memorySection = settings.locator('[data-companion-plan-section="memory"]')
  await expect(memorySection.getByText("Proposal to accept")).toBeVisible()
  await expect(memorySection.getByText("Proposal to reject")).toBeVisible()
  await expect(memorySection.getByText("Already active")).toHaveCount(0)

  await memorySection.locator('[data-companion-plan-memory-id="mem_accept"]').getByRole("button", { name: "Accept" }).click()
  await expect(settings.locator('[data-companion-plan-memory-id="mem_accept"]')).toHaveCount(0)
  await memorySection.locator('[data-companion-plan-memory-id="mem_reject"]').getByRole("button", { name: "Reject" }).click()
  await expect(settings.locator('[data-companion-plan-memory-id="mem_reject"]')).toHaveCount(0)

  const reminderSection = settings.locator('[data-companion-plan-section="reminders"]')
  const daily = reminderSection.locator('[data-companion-plan-reminder-id="sch_daily"]')
  await expect(daily.getByText("Daily review")).toBeVisible()
  await daily.getByRole("button", { name: "Pause" }).click()
  await expect(daily.getByText("paused")).toBeVisible()
  await daily.getByRole("button", { name: "Resume" }).click()
  await expect(daily.getByText("pending")).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await daily.getByRole("button", { name: "Cancel" }).click()
  await expect(settings.locator('[data-companion-plan-reminder-id="sch_daily"]')).toHaveCount(0)

  const continuitySection = settings.locator('[data-companion-plan-section="continuity"]')
  const workflow = continuitySection.locator('[data-companion-plan-continuity-id="cgr_workflow"]')
  await expect(workflow.getByText("Finish travel planning")).toBeVisible()
  await expect(workflow.getByText("not persisted to relationship Memory")).toHaveCount(0)
  const expired = continuitySection.locator('[data-companion-plan-continuity-id="cgr_expired"]')
  await expect(expired.getByText("expired")).toBeVisible()
  await expect(expired.getByRole("button", { name: "Approve" })).toBeDisabled()

  page.once("dialog", (dialog) => dialog.accept())
  await workflow.getByRole("button", { name: "Approve" }).click()
  await expect(workflow.getByText("active")).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await workflow.getByRole("button", { name: "Revoke" }).click()
  await expect(workflow.getByText("revoked")).toBeVisible()

  expect(forbiddenRequests).toEqual([])
  expect(
    requests.every(
      (item) => item.session === sessionID && item.workspace === workspaceID && item.profileID === undefined,
    ),
  ).toBe(true)
  expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual(
    expect.arrayContaining([
      "GET /memory",
      "GET /reminder",
      "GET /continuity-grant",
      "POST /memory/mem_accept/decision",
      "POST /memory/mem_reject/decision",
      "PATCH /reminder/sch_daily",
      "PATCH /reminder/sch_daily",
      "DELETE /reminder/sch_daily",
      "POST /continuity-grant/cgr_workflow/approve",
      "POST /continuity-grant/cgr_workflow/revoke",
    ]),
  )
})

test("mounts the Companion Plan review in v2 settings with isolated domains", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [session()],
    capability: capability(),
    pageMessages: () => ({ items: [] }),
    memory: {
      list: () => ({ items: [memory("mem_v2", "V2 proposal", "proposed")] }),
    },
    reminder: {
      list: () => [reminder("sch_v2", "V2 reminder", "pending", { recurrenceRule: "FREQ=WEEKLY;INTERVAL=1" })],
    },
    continuityGrant: {
      list: () => [grant("cgr_v2", "proposed")],
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
  await expect(settings).toBeVisible()
  await settings.getByRole("tab", { name: "Companion Plan" }).click()

  await expect(settings.locator('[data-companion-plan-section="memory"]').getByText("V2 proposal")).toBeVisible()
  await expect(settings.locator('[data-companion-plan-section="reminders"]').getByText("V2 reminder")).toBeVisible()
  await expect(settings.locator('[data-companion-plan-section="continuity"]').getByText("Finish travel planning")).toBeVisible()
})

function request(
  method: string,
  path: string,
  query: URLSearchParams,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): PlanRequest {
  return {
    method,
    path,
    workspace: query.get("workspace") ?? headers?.workspace ?? undefined,
    session: query.get("session") ?? headers?.session ?? undefined,
    profileID: query.get("profileID") ?? undefined,
    body,
  }
}

function capability() {
  return {
    profile: { id: "assistant", kind: "assistant", name: "Assistant", memory: "ask", proactive: false },
    workspace: { id: workspaceID, kind: "project", contentScope: "project", source: "metadata" },
    agent: { default: "build", current: "build", items: [{ name: "build", mode: "primary" }] },
    tools: [],
    mcp: [],
    skills: [],
    plugins: { loaded: 0 },
    memory: { policy: "ask", records: 3, availability: { available: true } },
    reminders: { proactive: false, paused: false, scheduled: 1, availability: { available: true } },
  }
}

function project() {
  return {
    id: "proj_companion_plan",
    worktree: directory,
    vcs: "git",
    name: "companion-plan",
    time: { created: now, updated: now },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "proj_companion_plan",
    directory,
    workspaceID,
    profileID: "assistant",
    title: "Companion Plan",
    version: "dev",
    time: { created: now, updated: now },
  }
}

function memory(id: string, content: string, status: MemoryInfo["status"]): MemoryInfo {
  return {
    id,
    workspaceID,
    profileID: "assistant",
    scope: "workspace",
    kind: "preference",
    content,
    provenance: "model_inferred",
    sensitivity: "normal",
    status,
    timeCreated: now,
    timeUpdated: now,
  }
}

function reminder(id: string, title: string, status: Reminder["status"], input: Partial<Reminder> = {}): Reminder {
  return {
    id,
    workspaceID,
    profileID: "assistant",
    sessionID,
    type: "reminder",
    title,
    body: "Review current priorities",
    scheduleAt: now + 60_000,
    timezone: "UTC",
    recurrenceRule: "FREQ=DAILY;INTERVAL=1",
    misfirePolicy: "catch_up_once",
    status,
    attemptCount: 0,
    timeCreated: now,
    timeUpdated: now,
    ...input,
  }
}

function grant(id: string, status: Grant["status"], input: Partial<Grant> = {}): Grant {
  return {
    id,
    sourceWorkspaceID: workspaceID,
    sourceDirectory: directory,
    sourceProfileID: "assistant",
    sourceSessionID: sessionID,
    destinationWorkspaceID: "wrk_personal",
    destinationDirectory: "personal",
    destinationProfileID: "companion",
    destinationSessionID: "ses_destination",
    purpose: "Finish travel planning",
    summary: "User selected the morning train.",
    relationshipPersistence: false,
    timeExpires: now + 60_000,
    status,
    timeCreated: now,
    timeUpdated: now,
    ...input,
  }
}
