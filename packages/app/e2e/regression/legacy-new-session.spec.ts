import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const draftID = "draft_legacy_new_session"
const directory = "C:/OpenCode/LegacyNewSession"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("redirects a draft to the legacy new-session route and shows scoped capabilities", async ({ page }) => {
  let capabilityRequests = 0
  let profileRuntimeRequests = 0
  let globalConfigRequests = 0
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_legacy_new_session",
      worktree: directory,
      vcs: "git",
      name: "legacy-new-session",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    capability: {
      profile: { id: "assistant", kind: "assistant", name: "Personal", memory: "ask", proactive: false },
      workspace: { id: "wrk_personal", kind: "personal", contentScope: "personal", source: "metadata" },
      agent: { default: "build", current: "build", items: [{ name: "build", mode: "primary" }] },
      tools: ["read", "write", "edit", "bash"].map((id) => ({ id, action: "allow" })),
      mcp: [{ name: "project-only", status: "unavailable", reason: "workspace_policy" }],
      skills: [],
      plugins: { loaded: 0 },
      memory: { policy: "ask", records: 0, availability: { available: true } },
      reminders: {
        proactive: false,
        paused: false,
        scheduled: 0,
        availability: { available: false, reason: "config_disabled" },
      },
    },
    profileRuntime: {
      id: "companion",
      kind: "companion",
      name: "Companion",
      persona: "Warm and concise",
      personaVersion: 2,
      memory: "ask",
      proactive: false,
      proactivePaused: false,
      proactiveFrequency: { maxPerDay: 3, minIntervalMinutes: 120 },
      crisisRegion: "CN",
    },
  })
  await page.route("**/capability?*", async (route) => {
    capabilityRequests += 1
    await route.fallback()
  })
  await page.route("**/global/profile/companion", async (route) => {
    profileRuntimeRequests += 1
    await route.fallback()
  })
  await page.route("**/global/config", async (route) => {
    globalConfigRequests += 1
    await route.fallback()
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  await page.goto(`/new-session?draftId=${draftID}`)

  await expect(page).toHaveURL(`/${base64Encode(directory)}/session`)
  await expect(page.locator("header[data-tauri-drag-region]")).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()

  expect(capabilityRequests).toBe(0)
  await page.getByRole("button", { name: /status/i }).click()
  await expect(page.getByText("Personal · personal scope · 4 tools")).toBeVisible()
  await page.getByRole("tab", { name: /mcp/i }).click()
  await expect(page.getByText("project-only")).toBeVisible()
  await expect(page.getByText("workspace policy")).toBeVisible()
  expect(capabilityRequests).toBe(1)

  await page.keyboard.press("Escape")
  const configBaseline = globalConfigRequests
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("tab", { name: "newhorse", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Persona" })).toHaveValue("Warm and concise")
  expect(profileRuntimeRequests).toBe(1)
  expect(globalConfigRequests).toBe(configBaseline)
})
