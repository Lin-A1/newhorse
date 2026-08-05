import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import type { ContinuityGrantAuditResponse, ContinuityGrantListResponse } from "@newhorse/sdk/v2"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/Continuity"
const workspaceID = "wrk_continuity_source"
const sessionID = "ses_continuity_source"
const destinationSessionID = "ses_continuity_destination"
const now = Date.now()

type Grant = ContinuityGrantListResponse[number]
type Audit = ContinuityGrantAuditResponse[number]
type ContinuityRequest = {
  method: string
  path: string
  directory?: string
  workspace?: string
  session?: string
  directoryHeader?: string
  workspaceHeader?: string
}

for (const layout of ["legacy", "v2"] as const) {
  test(`manages minimized Continuity grants in ${layout} settings`, async ({ page }) => {
    const requests: ContinuityRequest[] = []
    let grants = [
      grant("cgr_workflow", "proposed"),
      grant("cgr_expired", "proposed", { purpose: "Expired purpose", timeExpires: now - 1 }),
    ]
    const audits: Record<string, Audit[]> = {
      cgr_workflow: [audit("cga_proposed", "cgr_workflow", "proposed")],
    }

    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: { all: [], connected: [], default: {} },
      sessions: [session(), destinationSession()],
      capability: capability(),
      pageMessages: () => ({ items: [] }),
      continuityGrant: {
        list: (query, headers) => {
          requests.push(request("GET", "/continuity-grant", query, headers))
          return grants
        },
        audit: ({ grantID, query, headers }) => {
          requests.push(request("GET", `/continuity-grant/${grantID}/audit`, query, headers))
          return audits[grantID] ?? []
        },
        mutate: ({ action, grantID, query, headers }) => {
          requests.push(request("POST", `/continuity-grant/${grantID}/${action}`, query, headers))
          const index = grants.findIndex((item) => item.id === grantID)
          const item = grants[index]!
          const updated: Grant = {
            ...item,
            status: action === "approve" ? "active" : "revoked",
            ...(action === "approve" ? { timeApproved: now + 1 } : { timeRevoked: now + 2 }),
            timeUpdated: now + 2,
          }
          grants[index] = updated
          audits[grantID] = [
            ...(audits[grantID] ?? []),
            audit(
              action === "approve" ? "cga_approved" : "cga_revoked",
              grantID,
              action === "approve" ? "approved" : "revoked",
            ),
          ]
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
      { enabled: layout === "v2" },
    )

    const forbiddenRequests: string[] = []
    let monitorContinuity = false
    page.on("request", (networkRequest) => {
      if (!monitorContinuity) return
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

    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    if (layout === "legacy") {
      await page.getByRole("button", { name: "Settings" }).click()
    } else {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
    }
    const settings = page.locator(layout === "legacy" ? ".settings-dialog" : ".settings-v2-dialog")
    monitorContinuity = true
    await settings.getByRole("tab", { name: "Continuity Grants" }).click()

    const workflow = settings.locator('[data-continuity-grant-id="cgr_workflow"]')
    await expect(workflow).toContainText("proposed")
    await expect(workflow).toContainText("source assistant")
    await expect(workflow).toContainText("destination companion")
    await expect(workflow).toContainText(`Source session${sessionID}`)
    await expect(workflow).toContainText(`Source workspace${workspaceID}`)
    await expect(workflow).toContainText(`Destination session${destinationSessionID}`)
    await expect(workflow).toContainText("Finish travel planning")
    await expect(workflow).toContainText("User selected the morning train.")
    await expect(workflow).toContainText("not persisted to relationship Memory")
    await expect(settings.locator('[data-continuity-grant-id="cgr_expired"]')).toContainText("expired")

    await workflow.getByRole("button", { name: "Approve" }).click()
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(workflow).toContainText("active")

    await workflow.getByRole("button", { name: "View audit" }).click()
    const auditPanel = settings.locator('[data-continuity-audit="cgr_workflow"]')
    await expect(auditPanel).toContainText("proposed")
    await expect(auditPanel).toContainText("approved")
    await expect(auditPanel).not.toContainText("Finish travel planning")
    await expect(auditPanel).not.toContainText("morning train")

    await workflow.getByRole("button", { name: "Revoke" }).click()
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(workflow).toContainText("revoked")

    expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
      "GET /continuity-grant",
      "POST /continuity-grant/cgr_workflow/approve",
      "GET /continuity-grant/cgr_workflow/audit",
      "POST /continuity-grant/cgr_workflow/revoke",
    ])
    expect(
      requests.every(
        (item) =>
          (item.directory ?? decodeURIComponent(item.directoryHeader ?? "")) === directory &&
          (item.workspace ?? item.workspaceHeader) === workspaceID,
      ),
    ).toBe(true)
    expect(requests.every((item) => item.session === sessionID)).toBe(true)
    expect(forbiddenRequests).toEqual([])
  })
}

test("discards an in-flight Continuity list after switching source sessions", async ({ page }) => {
  const switchedSessionID = "ses_continuity_switched"
  const switchedDirectory = "C:/OpenCode/ContinuitySwitched"
  const switchedWorkspaceID = "wrk_continuity_switched"
  let releaseList!: () => void
  const listReady = new Promise<void>((resolve) => (releaseList = resolve))
  let markListRequested!: () => void
  const listRequested = new Promise<void>((resolve) => (markListRequested = resolve))

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [
      session(),
      destinationSession(),
      {
        ...session(),
        id: switchedSessionID,
        slug: switchedSessionID,
        directory: switchedDirectory,
        workspaceID: switchedWorkspaceID,
        title: "Switched Continuity",
      },
    ],
    capability: capability(),
    pageMessages: () => ({ items: [] }),
    continuityGrant: {
      list: async (query) => {
        if (query.get("session") === switchedSessionID) {
          return [
            grant("cgr_switched", "active", {
              sourceSessionID: switchedSessionID,
              sourceWorkspaceID: switchedWorkspaceID,
              sourceDirectory: switchedDirectory,
              purpose: "Switched source purpose",
            }),
          ]
        }
        markListRequested()
        await listReady
        return [grant("cgr_stale", "active", { purpose: "Stale source purpose" })]
      },
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: false, layoutTransitionEligible: true } }),
    )
    localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-dialog")
  await settings.getByRole("tab", { name: "Continuity Grants" }).click()
  await listRequested

  await page.evaluate(
    ({ path }) => {
      history.pushState({}, "", path)
      dispatchEvent(new PopStateEvent("popstate"))
    },
    { path: `/${base64Encode(switchedDirectory)}/session/${switchedSessionID}` },
  )
  await expect(settings.getByText("Loading Continuity grants…")).toBeVisible()
  await expect(settings.getByText("Switched source purpose")).toBeVisible()

  releaseList()
  await expect(settings.getByText("Stale source purpose")).toHaveCount(0)
  await expect(settings.locator('[data-continuity-grant-id="cgr_stale"]')).toHaveCount(0)
})

function request(
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string>,
): ContinuityRequest {
  return {
    method,
    path,
    directory: query.get("directory") ?? undefined,
    workspace: query.get("workspace") ?? undefined,
    session: query.get("session") ?? undefined,
    directoryHeader: headers["x-opencode-directory"],
    workspaceHeader: headers["x-opencode-workspace"],
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
    destinationDirectory: "C:/OpenCode/Personal",
    destinationProfileID: "companion",
    destinationSessionID,
    purpose: "Finish travel planning",
    summary: "User selected the morning train.",
    relationshipPersistence: false,
    timeExpires: now + 86_400_000,
    status,
    timeCreated: now,
    timeUpdated: now,
    ...input,
  }
}

function audit(id: string, grantID: string, action: Audit["action"]): Audit {
  return {
    id,
    grantID,
    action,
    outcome: "success",
    timeCreated: now,
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
    memory: { policy: "ask", records: 0, availability: { available: true } },
    reminders: { proactive: false, paused: false, scheduled: 0, availability: { available: false } },
  }
}

function project() {
  return {
    id: "proj_continuity",
    worktree: directory,
    vcs: "git",
    name: "continuity",
    time: { created: now, updated: now },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "proj_continuity",
    directory,
    workspaceID,
    profileID: "assistant",
    title: "Continuity source",
    version: "dev",
    time: { created: now, updated: now },
  }
}

function destinationSession() {
  return {
    ...session(),
    id: destinationSessionID,
    slug: destinationSessionID,
    directory: "C:/OpenCode/Personal",
    workspaceID: "wrk_personal",
    profileID: "companion",
    title: "Continuity destination",
  }
}
