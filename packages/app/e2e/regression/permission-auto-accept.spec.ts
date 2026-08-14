import { expect, test } from "@playwright/test"
import { base64Encode } from "@newhorse/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/AutoAccept"
const projectID = "proj_auto_accept"
const sessionID = "ses_auto_accept"
const title = "Auto accept repro"

test("auto-responds to a pending permission when config permission is allow", async ({ page }) => {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await mockOpenCodeServer(page, {
    sessions: [
      {
        id: sessionID,
        slug: "auto-accept",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "auto-accept", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    pageMessages: () => ({ items: [] }),
    permissions: [
      {
        id: "perm-1",
        sessionID,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      },
    ],
  })

  // Config `permission: "allow"` should make the app auto-respond.
  await page.route("**/config?*", (route) =>
    route.fulfill({ json: { permission: "allow" }, headers: { "access-control-allow-origin": "*" } }),
  )

  const transport = await installSseTransport(page, { server, retry: 20 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  // Deliver the permission.asked event, which triggers auto-respond.
  const reply = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().includes(`/session/${sessionID}/permissions/perm-1`),
    { timeout: 8000 },
  )
  await transport.send({
    id: "evt_perm_1",
    type: "permission.asked",
    data: {
      id: "perm-1",
      sessionID,
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
    },
    location: { directory },
  })
  await reply

  const permissionDock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(permissionDock).toHaveCount(0)
  await transport.close()
})
