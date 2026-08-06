import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/ProfileCards"
const draftID = "draft_profile_cards"
const workspaceID = "wrk_profilecards"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const now = Date.parse("2030-01-01T09:00:00Z")

const assistantProfile = { id: "assistant", kind: "assistant", name: "Assistant", memory: "ask", proactive: false }
const companionProfile = { id: "companion", kind: "companion", name: "Companion", memory: "ask", proactive: false }

test("profile cards reflect selection highlight and checkmark", async ({ page }) => {
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.0.0" }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_profilecards",
      worktree: directory,
      vcs: "git",
      name: "profilecards",
      time: { created: now, updated: now },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    capability: {
      profile: { id: "assistant", kind: "assistant", name: "Assistant", memory: "ask", proactive: false },
      workspace: { id: workspaceID, kind: "personal", contentScope: "personal", source: "metadata" },
      agent: { default: "build", current: "build", items: [{ name: "build", mode: "primary" }] },
      tools: [],
      mcp: [],
      skills: [],
      plugins: { loaded: 0 },
      memory: { policy: "ask", records: 0, availability: { available: true } },
      reminders: { proactive: false, paused: false, scheduled: 0, availability: { available: true } },
    },
  })
  await page.route("**/global/profile*", async (route) => {
    await route.fulfill({ json: { active: "assistant", items: [assistantProfile, companionProfile] } })
  })
  await page.route("**/global/config*", async (route) => route.fulfill({ json: {} }))

  await page.goto(`/new-session?draftId=${draftID}`)
  await page.waitForSelector('[data-profile-card="assistant"]')

  const assistant = page.locator('[data-profile-card="assistant"]')
  const companion = page.locator('[data-profile-card="companion"]')

  await expect(assistant).toHaveAttribute("aria-checked", "true")
  await expect(companion).toHaveAttribute("aria-checked", "false")

  await companion.click()
  await expect(assistant).toHaveAttribute("aria-checked", "false")
  await expect(companion).toHaveAttribute("aria-checked", "true")

  await assistant.click()
  await expect(assistant).toHaveAttribute("aria-checked", "true")
  await expect(companion).toHaveAttribute("aria-checked", "false")
})
