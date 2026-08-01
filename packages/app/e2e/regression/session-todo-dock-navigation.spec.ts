import { base64Encode } from "@newhorse/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TodoDockNavigation"
const projectID = "proj_todo_dock_navigation"
const sourceID = "ses_todo_dock_source"
const otherID = "ses_todo_dock_other"
const sourceTitle = "Todo dock animation"
const otherTitle = "Separate session"

const activeTodos = [
  { id: "todo-1", content: "Receive todos in the active session", status: "completed", priority: "high" },
  { id: "todo-2", content: "Keep the dock visible across tabs", status: "completed", priority: "high" },
  { id: "todo-3", content: "Close after the final todo", status: "in_progress", priority: "high" },
]

type EventPayload = {
  directory: string
  payload: Record<string, unknown>
}

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" })

test("preserves todo lifecycle without replaying it across session tabs", async ({ page }) => {
  test.setTimeout(90_000)
  const events: EventPayload[] = []
  const todos: Record<string, typeof activeTodos> = { [sourceID]: [], [otherID]: [] }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-dock-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, sourceTitle, 1700000000000), session(otherID, otherTitle, 1700000001000)],
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
    todos: (sessionID) => todos[sessionID] ?? [],
  })
  await configurePage(page)

  await page.goto(sessionHref(sourceID))
  await expectSessionTitle(page, sourceTitle)
  const dock = page.locator('[data-component="session-todo-dock"]')
  await expect(dock).toHaveCount(0)

  events.push(statusEvent(sourceID, "busy"))
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

  todos[sourceID] = activeTodos
  events.push(todoEvent(sourceID, activeTodos))
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)
  const progressLabel = dock.locator('[data-action="session-todo-toggle"] span[aria-label*="todos completed"]')
  await expect(progressLabel).toHaveCSS("opacity", "1")

  await switchSession(page, otherID, otherTitle)
  await expect(dock).toHaveCount(0)

  const firstReturnOpacity = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const read = () => {
          const label = document.querySelector<HTMLElement>(
            '[data-component="session-todo-dock"] [data-action="session-todo-toggle"] span[aria-label*="todos completed"]',
          )
          if (!label) return false
          resolve(Number.parseFloat(getComputedStyle(label).opacity))
          return true
        }
        if (read()) return
        const observer = new MutationObserver(() => {
          if (!read()) return
          observer.disconnect()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      }),
  )
  await switchSession(page, sourceID, sourceTitle)
  expect(await firstReturnOpacity).toBeGreaterThan(0.98)
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)
  await expect(progressLabel).toHaveCSS("opacity", "1")

  const completedTodos = activeTodos.map((todo) => ({ ...todo, status: "completed" }))
  todos[sourceID] = completedTodos
  events.push(todoEvent(sourceID, completedTodos))
  await expect(dock).toHaveCount(0)
  todos[sourceID] = []
  events.push(todoEvent(sourceID, []))

  await switchSession(page, otherID, otherTitle)
  await switchSession(page, sourceID, sourceTitle)
  await expect(dock).toHaveCount(0)
})

function session(id: string, title: string, created: number) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
  }
}

function statusEvent(sessionID: string, type: "busy" | "idle"): EventPayload {
  return {
    directory,
    payload: { type: "session.status", properties: { sessionID, status: { type } } },
  }
}

function todoEvent(sessionID: string, next: typeof activeTodos): EventPayload {
  return {
    directory,
    payload: { type: "todo.updated", properties: { sessionID, todos: next } },
  }
}

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionIDs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server, dirBase64, sessionId }))),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionIDs: [sourceID, otherID] },
  )
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

async function switchSession(page: Page, sessionID: string, title: string) {
  const href = sessionHref(sessionID)
  const tab = page.locator(`[data-slot="titlebar-tabs"] a[href="${href}"]`).first()
  await expect(tab).toBeVisible()
  await tab.click()
  await expectSessionTitle(page, title)
}
