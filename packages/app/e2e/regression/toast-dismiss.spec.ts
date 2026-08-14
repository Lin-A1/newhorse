import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const sessionID = fixture.sourceID
const directory = fixture.directory
const title = fixture.expected.sourceTitle

async function mockSession(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory,
    project: fixture.project,
    pageMessages,
  })
  // Force the delete to fail so the app shows the delete-error toast.
  await page.route(/session\/ses_smoke_source$/, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback()
    return route.fulfill({ status: 400, body: "busy", headers: { "access-control-allow-origin": "*" } })
  })
}

test("delete-error toast auto-dismisses", async ({ page }) => {
  await mockSession(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await page.getByRole("button", { name: "More options" }).click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await page.getByRole("button", { name: "Delete session" }).click()

  const toast = page.locator('[data-component="toast-v2"]')
  await expect(toast).toContainText("Failed to delete session")

  // Must auto-dismiss within a few seconds of the 5s default.
  await expect(toast).toHaveCount(0, { timeout: 9000 })
})

test("delete-error toast close button dismisses it", async ({ page }) => {
  await mockSession(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await page.getByRole("button", { name: "More options" }).click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  await page.getByRole("button", { name: "Delete session" }).click()

  const toast = page.locator('[data-component="toast-v2"]')
  await expect(toast).toContainText("Failed to delete session")

  await toast.locator('[data-slot="toast-v2-close-button"]').click()
  await expect(toast).toHaveCount(0, { timeout: 5000 })
})
