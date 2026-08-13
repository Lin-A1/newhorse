import { base64Encode } from "@newhorse/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const sessionID = "ses_companion_rename"
const directory = "C:/OpenCode/CompanionRename"
const defaultTitle = "New session - 2026-08-13T00:00:00.000Z"

test("companion (newhorse) session can be renamed and keeps the custom title", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: [
      {
        id: sessionID,
        slug: "companion",
        projectID: "proj_companion_rename",
        directory,
        title: defaultTitle,
        profileID: "companion",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    provider: fixture.provider,
    directory,
    project: { id: "proj_companion_rename", worktree: directory, title: "Companion rename" },
    pageMessages,
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "newhorse")

  // Click the header title to open the inline rename editor.
  const title = page.locator('[data-slot="session-title-child"]')
  await expect(title).toHaveText("newhorse")
  await title.click()

  // Replace the brand name with a custom title and commit.
  const editor = page.locator('[data-slot="session-title-child"][contenteditable], input[data-slot="session-title-child"]')
  await expect(editor).toBeVisible()
  await editor.fill("我的助手")
  await editor.press("Enter")

  // Regression: the companion session used to snap back to the brand name.
  await expect(page.locator('[data-slot="session-title-child"]')).toHaveText("我的助手")
})
