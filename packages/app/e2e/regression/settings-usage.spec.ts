import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/UsageCheck"
const workspaceID = "wrk_usage"
const sessionID = "ses_usage"
const now = Date.parse("2030-01-01T09:00:00Z")

test("usage tab aggregates model cost and cache stats", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.0.0" }))
  })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_usage",
      worktree: directory,
      vcs: "git",
      name: "usage",
      time: { created: now, updated: now },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "proj_usage",
        directory,
        workspaceID,
        profileID: "assistant",
        title: "Usage Test",
        version: "dev",
        time: { created: now, updated: now },
        cost: 1.25,
        tokens: { input: 1000, output: 500, reasoning: 100, cache: { read: 800, write: 50 } },
      },
    ],
    pageMessages: () => ({ items: [] }),
    capability: {
      profile: { id: "assistant", kind: "assistant", name: "Assistant", memory: "ask", proactive: false },
      workspace: { id: workspaceID, kind: "personal", contentScope: "personal", source: "metadata" },
      agent: { default: "build", current: "build", items: [{ name: "build", mode: "primary" }] },
      tools: [], mcp: [], skills: [], plugins: { loaded: 0 },
      memory: { policy: "ask", records: 0, availability: { available: true } },
      reminders: { proactive: false, paused: false, scheduled: 0, availability: { available: true } },
    },
  })
  await page.route("**/global/config*", async (route) => route.fulfill({ json: {} }))

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.keyboard.press("Control+,")
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Usage" }).click()

  await expect(settings.getByText("Sessions", { exact: true }).first()).toBeVisible()
  await expect(settings.getByText("1", { exact: true }).first()).toBeVisible()
  await expect(settings.getByText("$1.25", { exact: true }).first()).toBeVisible()
  await expect(settings.getByText("1,000", { exact: true })).toBeVisible()
  await expect(settings.getByText("500", { exact: true })).toBeVisible()
  await expect(settings.getByText("Cache hit rate", { exact: true })).toBeVisible()
  await expect(settings.getByText("800 / 1,000 · 80.0%", { exact: true })).toBeVisible()
})
