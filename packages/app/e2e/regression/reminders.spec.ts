import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import type { ReminderAuditResponses, ReminderListResponses } from "@newhorse/sdk/v2"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/Reminders"
const workspaceID = "wrk_reminders"
const sessionID = "ses_reminders"
const now = Date.parse("2030-01-01T09:00:00Z")

type Reminder = ReminderListResponses[200][number]
type AuditPage = ReminderAuditResponses[200]
type RequestRecord = {
  method: string
  path: string
  workspace?: string
  session?: string
  body?: Record<string, unknown>
}

for (const layout of ["legacy", "v2"] as const) {
  test(`manages recurring reminders and audit in ${layout} settings`, async ({ page }) => {
    const requests: RequestRecord[] = []
    let reminders = [reminder("sch_recurring", "Daily review", "pending")]
    const audits: Record<string, AuditPage> = {
      sch_recurring: {
        items: [
          {
            id: "sha_created",
            eventID: "sch_recurring",
            action: "created",
            outcome: "success",
            timeCreated: now,
          },
        ],
        nextCursor: "sha_cursor",
      },
    }

    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: { all: [], connected: [], default: {} },
      sessions: [session()],
      capability: capability(),
      pageMessages: () => ({ items: [] }),
      reminder: {
        list: (query) => {
          requests.push(record("GET", "/reminder", query))
          return reminders
        },
        audit: ({ reminderID, query }) => {
          requests.push(record("GET", `/reminder/${reminderID}/audit`, query))
          if (query.get("cursor") === "sha_cursor") {
            return {
              items: [
                {
                  id: "sha_delivered",
                  eventID: reminderID,
                  action: "delivered",
                  outcome: "success",
                  occurrenceAt: now,
                  deliveryKey: "sch_recurring:1893498000000",
                  timeCreated: now + 1,
                },
              ],
            } satisfies AuditPage
          }
          return audits[reminderID] ?? { items: [] }
        },
        mutate: ({ method, path, query, body }) => {
          requests.push(record(method, path, query, body as Record<string, unknown> | undefined))
          if (method === "POST" && path === "/reminder") {
            const created = reminder("sch_created", (body as { title: string }).title, "pending", {
              body: (body as { body: string }).body,
              scheduleAt: (body as { scheduleAt: number }).scheduleAt,
              timezone: (body as { timezone: string }).timezone,
              recurrenceRule: undefined,
            })
            reminders = [created, ...reminders]
            return created
          }
          const id = path.split("/")[2]!
          const index = reminders.findIndex((item) => item.id === id)
          if (method === "DELETE") {
            reminders[index] = { ...reminders[index]!, status: "cancelled", timeUpdated: now + 3 }
            return true
          }
          const input = body as { paused?: boolean } & Partial<Reminder>
          reminders[index] = {
            ...reminders[index]!,
            ...input,
            status: input.paused === undefined ? reminders[index]!.status : input.paused ? "paused" : "pending",
            timeUpdated: now + 2,
          }
          return reminders[index]
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

    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    if (layout === "legacy") await page.getByRole("button", { name: "Settings" }).click()
    else await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
    const settings = page.locator(layout === "legacy" ? ".settings-dialog" : ".settings-v2-dialog")
    await settings.getByRole("tab", { name: "Reminders" }).click()

    const recurring = settings.locator('[data-reminder-id="sch_recurring"]')
    await expect(recurring).toContainText("Daily review")
    await expect(recurring).toContainText("Every day")
    await recurring.getByRole("button", { name: "Pause" }).click()
    await expect(recurring).toContainText("paused")
    await recurring.getByRole("button", { name: "Resume" }).click()
    await expect(recurring).toContainText("pending")

    await recurring.getByRole("button", { name: "Show audit" }).click()
    const auditPanel = recurring.locator('[data-reminder-audit="sch_recurring"]')
    await expect(auditPanel).toContainText("created · success")
    await recurring.getByRole("button", { name: "Load more audit" }).click()
    await expect(auditPanel).toContainText("delivered · success")
    await expect(auditPanel).toContainText("sch_recurring:1893498000000")
    await expect(auditPanel).not.toContainText("Review current priorities")

    await settings.getByRole("button", { name: "New reminder" }).click()
    await settings.getByRole("textbox", { name: "Title" }).fill("Created in settings")
    await settings.getByRole("textbox", { name: "Body" }).fill("Remember this task")
    await settings.getByLabel("Schedule").fill("2030-01-02T03:04")
    await settings.getByRole("button", { name: "Create", exact: true }).click()
    await expect(settings.locator('[data-reminder-id="sch_created"]')).toContainText("Created in settings")

    page.once("dialog", (dialog) => dialog.accept())
    await recurring.getByRole("button", { name: "Cancel" }).click()
    await expect(recurring).toContainText("cancelled")

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /reminder",
      "PATCH /reminder/sch_recurring",
      "PATCH /reminder/sch_recurring",
      "GET /reminder/sch_recurring/audit",
      "GET /reminder/sch_recurring/audit",
      "POST /reminder",
      "DELETE /reminder/sch_recurring",
    ])
    expect(requests.every((request) => request.workspace === workspaceID && request.session === sessionID)).toBe(true)
    expect(
      requests.every(
        (request) => request.body?.profileID === undefined && request.body?.sessionID === undefined,
      ),
    ).toBe(true)
  })
}

function record(method: string, path: string, query: URLSearchParams, body?: Record<string, unknown>): RequestRecord {
  return {
    method,
    path,
    workspace: query.get("workspace") ?? undefined,
    session: query.get("session") ?? undefined,
    body,
  }
}

function reminder(
  id: string,
  title: string,
  status: Reminder["status"],
  input: Partial<Reminder> = {},
): Reminder {
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
    reminders: { proactive: false, paused: false, scheduled: 1, availability: { available: true } },
  }
}

function project() {
  return {
    id: "proj_reminders",
    worktree: directory,
    vcs: "git",
    name: "reminders",
    time: { created: now, updated: now },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "proj_reminders",
    directory,
    workspaceID,
    profileID: "assistant",
    title: "Reminder Center",
    version: "dev",
    time: { created: now, updated: now },
  }
}
