import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/LocVerify"
const workspaceID = "wrk_locverify"
const sessionID = "ses_locverify"
const now = Date.parse("2030-01-01T09:00:00Z")

test("localized tabs info popup and drawer render Chinese copy", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "zh" }))
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.0.0" }))
  })
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: { all: [], connected: [], default: {} },
    sessions: [session()],
    capability: capability(),
    pageMessages: () => ({ items: [] }),
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const popover = page.getByLabel("标签页介绍。用标签页整理你的工作和活跃会话")
  await expect(popover).toBeVisible()
  await expect(popover).toContainText("标签页介绍")
  await expect(popover).toContainText("用标签页整理你的工作和活跃会话")
  await expect(popover).not.toContainText("Introducing Tabs")

  await popover.getByRole("button", { name: "用标签页整理你的工作和活跃会话" }).click()
  const drawer = page.locator('[role="dialog"]')
  await expect(drawer).toContainText("newhorse Desktop 现在以标签页为核心构建。")
  await expect(drawer).toContainText("在标签页中开始新会话，或从任意项目中打开现有会话。开始新工作时打开一个新标签页，完成后关闭它。")
  await expect(drawer).not.toContainText("newhorse Desktop is now built around tabs.")
})

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
    reminders: { proactive: false, paused: false, scheduled: 0, availability: { available: true } },
  }
}

function project() {
  return {
    id: "proj_locverify",
    worktree: directory,
    vcs: "git",
    name: "locverify",
    time: { created: now, updated: now },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "proj_locverify",
    directory,
    workspaceID,
    profileID: "assistant",
    title: "Localization verify",
    version: "dev",
    time: { created: now, updated: now },
  }
}
