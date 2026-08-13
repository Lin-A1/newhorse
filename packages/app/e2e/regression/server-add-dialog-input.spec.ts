import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

test("add-server dialog: fields stay editable while the submit health check runs", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: [],
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })

  await page.goto("/")
  await expectAppVisible(page.locator("body"))

  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog").last()
  await settings.getByRole("tab", { name: "Servers" }).click()
  await settings.getByRole("button", { name: "Add server" }).click()
  const addDialog = page.getByRole("dialog").last()
  const urlInput = addDialog.locator('input[data-slot="text-input-v2-input"]').nth(0)
  const nameInput = addDialog.locator('input[data-slot="text-input-v2-input"]').nth(1)
  await expect(urlInput).toBeVisible()

  // Hang the health check so the submit mutation stays pending.
  await page.route("**://127.0.0.1:3999/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })

  await urlInput.click()
  await page.keyboard.type("http://127.0.0.1:3999")
  await expect(urlInput).toHaveValue("http://127.0.0.1:3999")

  // Press Enter → submits. The health check hangs → mutation stays pending.
  await urlInput.press("Enter")
  await expect(addDialog.getByText("Checking...")).toBeVisible()

  // Regression: while the check runs, every input used to be disabled, so the
  // user could not type for up to the 30s health-check timeout. They must stay
  // editable; only the submit button reflects the in-flight check.
  await expect(urlInput).toBeEnabled()
  await expect(nameInput).toBeEnabled()
  await nameInput.click()
  await page.keyboard.type("still-editable")
  await expect(nameInput).toHaveValue("still-editable")
})

test("add-server dialog: fields accept real typing after switching focus", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: [],
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })

  await page.goto("/")
  await expectAppVisible(page.locator("body"))

  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog").last()
  await settings.getByRole("tab", { name: "Servers" }).click()
  await settings.getByRole("button", { name: "Add server" }).click()
  const addDialog = page.getByRole("dialog").last()
  const urlInput = addDialog.locator('input[data-slot="text-input-v2-input"]').nth(0)
  const nameInput = addDialog.locator('input[data-slot="text-input-v2-input"]').nth(1)
  await expect(urlInput).toBeVisible()

  await urlInput.click()
  await page.keyboard.type("http://127.0.0.1:3999")
  await expect(urlInput).toHaveValue("http://127.0.0.1:3999")

  await nameInput.click()
  await page.keyboard.type("test-server")
  await expect(nameInput).toHaveValue("test-server")

  // Clicking back into a field must keep accepting real input.
  await urlInput.click()
  await page.keyboard.type("-extra")
  await expect(urlInput).toHaveValue("http://127.0.0.1:3999-extra")
})
