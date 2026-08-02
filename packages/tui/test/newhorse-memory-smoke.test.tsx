/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@newhorse/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { Global } from "@newhorse/core/global"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"

const memory = {
  id: "mem_smoke",
  scope: "workspace",
  kind: "preference",
  content: "Use concise progress updates",
  provenance: "model_inferred",
  sensitivity: "normal",
  status: "proposed",
  sourceMessageID: "msg_smoke",
  timeCreated: 1,
  timeUpdated: 1,
} as const

const sessionID = "ses_memory_routing"
const session = {
  id: sessionID,
  slug: sessionID,
  projectID: "proj_test",
  directory,
  workspaceID: "personal",
  profileID: "companion",
  title: "Memory routing",
  version: "dev",
  time: { created: 1, updated: 1 },
}

const secondSessionID = "ses_memory_second_workspace"
const secondWorkspaceID = "project-secondary"
const secondSession = {
  ...session,
  id: secondSessionID,
  slug: secondSessionID,
  workspaceID: secondWorkspaceID,
  profileID: "assistant",
  title: "Second Workspace Session",
}

type RecordedRequest = {
  method: string
  path: string
  query: string
  workspace?: string
  legacyWorkspace?: string
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000, diagnostics?: () => unknown) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeout) {
      const detail = diagnostics?.()
      if (detail !== undefined) console.error("waitFor diagnostics", detail)
      throw new Error(detail === undefined ? "timed out" : `timed out: ${JSON.stringify(detail)}`)
    }
    await Bun.sleep(10)
  }
}

type TuiHarness = {
  api: TuiPluginApi
  events: ReturnType<typeof createEventSource>
  render: () => Promise<string>
  state: string
  mockInput: Awaited<ReturnType<typeof createTestRenderer>>["mockInput"]
}

async function withTui(
  createFetchForTest: (
    fallback: typeof globalThis.fetch,
    events: ReturnType<typeof createEventSource>,
  ) => typeof globalThis.fetch,
  verify: (harness: TuiHarness) => Promise<void>,
  initialKV: Record<string, unknown> = {},
) {
  await using root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify(initialKV))
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const fallback = createFetch(undefined, events)
  const fetch = createFetchForTest(fallback.fetch, events)
  let api: TuiPluginApi | undefined
  let ready!: () => void
  const started = new Promise<void>((resolve) => (ready = resolve))
  let task: Promise<void> | undefined

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            ready()
          },
          async dispose() {},
        },
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(Global.node, [[Global.node, Global.layerWith({ state, data: root.path })]]),
        ),
      ),
    )
    await started
    await verify({
      api: api!,
      events,
      state,
      mockInput: setup.mockInput,
      async render() {
        await setup.renderOnce()
        return setup.captureCharFrame()
      },
    })
  } finally {
    if (!setup.renderer.isDestroyed) api?.keymap.dispatchCommand("app.exit")
    await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}

test("opens /memory and accepts a proposal through the full TUI", async () => {
  const requests: RecordedRequest[] = []
  let status: "proposed" | "active" = "proposed"

  await withTui(
    (fallback) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          workspace: url.searchParams.get("workspace") ?? undefined,
          legacyWorkspace: request.headers.get("x-opencode-workspace") ?? undefined,
        })
        if (url.pathname === "/capability")
          return Response.json({
            profile: { id: "assistant", kind: "assistant", name: "Assistant", memory: "ask", proactive: false },
            workspace: { id: "personal", kind: "personal", contentScope: "personal", source: "metadata" },
            tools: [],
            agents: [],
            extensions: [],
          })
        if (url.pathname === "/memory" && request.method === "GET")
          return Response.json({ items: [{ ...memory, status }], nextCursor: undefined })
        if (url.pathname === "/memory/mem_smoke/decision" && request.method === "POST") {
          expect(await request.json()).toEqual({ scope: "workspace", decision: "accept" })
          status = "active"
          return Response.json({ ...memory, status })
        }
        return fallback(request)
      }) as typeof globalThis.fetch,
    async ({ api, render }) => {
      api.keymap.dispatchCommand("memory.list")
      await waitFor(() => requests.some((request) => request.method === "GET" && request.path === "/memory"))
      await waitFor(async () => (await render()).includes("Use concise progress updates"))
      expect(await render()).toContain("Memory Center")

      await waitFor(async () => (await render()).includes("alt+a"))
      const result = api.keymap.dispatchCommand("dialog.memory.accept")
      if (!result.ok) throw new Error(JSON.stringify(result))
      await waitFor(() =>
        requests.some((request) => request.method === "POST" && request.path === "/memory/mem_smoke/decision"),
      )
      await waitFor(async () => (await render()).includes("active"))
      expect(requests.filter((request) => request.method === "GET" && request.path === "/memory")).toHaveLength(1)
    },
  )
}, 20_000)

test("waits for immutable Session metadata before loading Memory", async () => {
  const requests: RecordedRequest[] = []
  let releaseSession!: () => void
  const sessionReady = new Promise<void>((resolve) => (releaseSession = resolve))

  await withTui(
    (fallback) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          workspace: url.searchParams.get("workspace") ?? undefined,
          legacyWorkspace: request.headers.get("x-opencode-workspace") ?? undefined,
        })
        if (url.pathname === `/session/${sessionID}`) {
          await sessionReady
          return Response.json(session)
        }
        if (
          url.pathname === `/session/${sessionID}/message` ||
          url.pathname === `/session/${sessionID}/todo` ||
          url.pathname === `/session/${sessionID}/diff`
        )
          return Response.json([])
        if (url.pathname === "/capability")
          return Response.json({
            profile: { id: "companion", kind: "companion", name: "Companion", memory: "ask", proactive: false },
            workspace: { id: "personal", kind: "personal", contentScope: "personal", source: "metadata" },
            tools: [],
            agents: [],
            extensions: [],
          })
        if (url.pathname === "/memory" && request.method === "GET")
          return Response.json({
            items: [{ ...memory, id: "mem_session", content: "Trusted Session Memory" }],
            nextCursor: undefined,
          })
        return fallback(request)
      }) as typeof globalThis.fetch,
    async ({ api, render }) => {
      api.route.navigate("session", { sessionID })
      await waitFor(() => requests.some((request) => request.path === `/session/${sessionID}`))
      api.keymap.dispatchCommand("memory.list")
      await render()
      expect(requests.filter((request) => request.path === "/capability" || request.path === "/memory")).toEqual([])

      releaseSession()
      await waitFor(() => api.state.session.get(sessionID) !== undefined)
      expect({ open: api.ui.dialog.open, depth: api.ui.dialog.depth }).toEqual({ open: true, depth: 1 })
      expect(await render()).toContain("Memory Center")
      await waitFor(
        async () => {
          await render()
          return requests.some(
            (request) =>
              request.method === "GET" &&
              request.path === "/memory" &&
              new URLSearchParams(request.query).get("session") === sessionID &&
              request.workspace === "personal",
          )
        },
        5000,
        () => requests.filter((request) => request.path === "/capability" || request.path === "/memory"),
      )
      await waitFor(async () => (await render()).includes("Trusted Session Memory"))
      expect(requests.filter((request) => request.path === "/capability" || request.path === "/memory")).toEqual([
        expect.objectContaining({
          method: "GET",
          path: "/capability",
          workspace: "personal",
          legacyWorkspace: undefined,
        }),
        expect.objectContaining({
          method: "GET",
          path: "/memory",
          workspace: "personal",
          legacyWorkspace: undefined,
        }),
      ])
      expect(requests.every((request) => !new URLSearchParams(request.query).has("profileID"))).toBe(true)
    },
  )
}, 20_000)

test("reloads an open Memory dialog with the Session Workspace client", async () => {
  const requests: RecordedRequest[] = []

  await withTui(
    (fallback) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          workspace: url.searchParams.get("workspace") ?? undefined,
          legacyWorkspace: request.headers.get("x-opencode-workspace") ?? undefined,
        })
        if (url.pathname === `/session/${secondSessionID}`) return Response.json(secondSession)
        if (
          url.pathname === `/session/${secondSessionID}/message` ||
          url.pathname === `/session/${secondSessionID}/todo` ||
          url.pathname === `/session/${secondSessionID}/diff`
        )
          return Response.json([])
        if (url.pathname === "/capability") {
          const secondary = url.searchParams.get("session") === secondSessionID
          return Response.json({
            profile: { id: "assistant", kind: "assistant", name: "Assistant", memory: "ask", proactive: false },
            workspace: secondary
              ? { id: secondWorkspaceID, kind: "project", contentScope: "project", source: "metadata" }
              : { id: "personal", kind: "personal", contentScope: "personal", source: "metadata" },
            tools: [],
            agents: [],
            extensions: [],
          })
        }
        if (url.pathname === "/memory" && request.method === "GET") {
          const secondary = url.searchParams.get("session") === secondSessionID
          return Response.json({
            items: [
              {
                ...memory,
                id: secondary ? "mem_second_workspace" : memory.id,
                content: secondary ? "Second Workspace Memory" : memory.content,
              },
            ],
            nextCursor: undefined,
          })
        }
        return fallback(request)
      }) as typeof globalThis.fetch,
    async ({ api, render }) => {
      api.keymap.dispatchCommand("memory.list")
      await waitFor(async () => (await render()).includes("Use concise progress updates"))

      requests.length = 0
      api.route.navigate("session", { sessionID: secondSessionID })
      await waitFor(
        () =>
          requests.filter((request) => request.path === `/session/${secondSessionID}`).length >= 2 &&
          requests.some((request) => request.path === `/session/${secondSessionID}/message`) &&
          requests.some((request) => request.path === `/session/${secondSessionID}/todo`) &&
          requests.some((request) => request.path === `/session/${secondSessionID}/diff`) &&
          api.state.session.get(secondSessionID) !== undefined,
      )
      expect({ open: api.ui.dialog.open, depth: api.ui.dialog.depth }).toEqual({ open: true, depth: 1 })
      expect(await render()).toContain("Memory Center")
      await waitFor(async () => {
        await render()
        return requests.some(
          (request) =>
            request.method === "GET" &&
            request.path === "/memory" &&
            new URLSearchParams(request.query).get("session") === secondSessionID &&
            request.workspace === secondWorkspaceID,
        )
      })
      await waitFor(async () => {
        const frame = await render()
        return frame.includes("Second Workspace Memory") && !frame.includes("Use concise progress updates")
      })
      expect(requests.filter((request) => request.path === "/capability" || request.path === "/memory")).toEqual([
        expect.objectContaining({
          method: "GET",
          path: "/capability",
          workspace: secondWorkspaceID,
          legacyWorkspace: undefined,
        }),
        expect.objectContaining({
          method: "GET",
          path: "/memory",
          workspace: secondWorkspaceID,
          legacyWorkspace: undefined,
        }),
      ])
      expect(requests.every((request) => !new URLSearchParams(request.query).has("profileID"))).toBe(true)
    },
  )
}, 20_000)

test("deduplicates mounted reminder delivery across restart persistence", async () => {
  const persistedKey = "sch_persisted:1"
  const freshKey = "sch_fresh:2"
  await withTui(
    (fallback) => fallback,
    async ({ api, events, render, state }) => {
      await waitFor(() => api.state.ready)
      const due = (deliveryKey: string, title: string) => ({
        directory,
        workspace: undefined,
        payload: {
          type: "scheduled-event.due" as const,
          properties: {
            id: deliveryKey.split(":")[0]!,
            profileID: "assistant",
            eventType: "reminder" as const,
            title,
            body: `${title} body`,
            scheduleAt: 1,
            occurrenceAt: 1,
            deliveryKey,
            attemptCount: 1,
          },
        },
      })

      events.emit(due(persistedKey, "Persisted duplicate"))
      await render()
      expect(await render()).not.toContain("Persisted duplicate")

      events.emit(due(freshKey, "Fresh reminder"))
      events.emit(due(freshKey, "Fresh reminder"))
      await waitFor(async () => (await render()).includes("Fresh reminder"))
      await waitFor(async () => {
        const saved = JSON.parse(await Bun.file(path.join(state, "kv.json")).text()) as Record<string, unknown>
        return JSON.stringify(saved["reminder_delivery_keys.v1"]) === JSON.stringify([persistedKey, freshKey])
      })
    },
    { "reminder_delivery_keys.v1": [persistedKey] },
  )
}, 20_000)

test("opens /reminders, pauses a series, and reads content-free audit through the full TUI", async () => {
  const requests: RecordedRequest[] = []
  const reminder = {
    id: "sch_smoke",
    workspaceID: "personal",
    profileID: "companion",
    sessionID,
    type: "reminder",
    title: "Daily reflection",
    body: "Review the day",
    scheduleAt: Date.parse("2030-01-02T03:04:00Z"),
    timezone: "UTC",
    recurrenceRule: "FREQ=DAILY;INTERVAL=1",
    misfirePolicy: "catch_up_once",
    status: "pending" as "pending" | "paused",
    attemptCount: 0,
    timeCreated: 1,
    timeUpdated: 1,
  }

  await withTui(
    (fallback) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          workspace: url.searchParams.get("workspace") ?? undefined,
          legacyWorkspace: request.headers.get("x-opencode-workspace") ?? undefined,
        })
        if (url.pathname === `/session/${sessionID}`) return Response.json(session)
        if (
          url.pathname === `/session/${sessionID}/message` ||
          url.pathname === `/session/${sessionID}/todo` ||
          url.pathname === `/session/${sessionID}/diff`
        )
          return Response.json([])
        if (url.pathname === "/reminder" && request.method === "GET") return Response.json([reminder])
        if (url.pathname === "/reminder/sch_smoke" && request.method === "PATCH") {
          expect(await request.json()).toEqual({ paused: true })
          reminder.status = "paused"
          return Response.json(reminder)
        }
        if (url.pathname === "/reminder/sch_smoke/audit" && request.method === "GET")
          return Response.json({
            items: [
              {
                id: "sha_smoke",
                eventID: reminder.id,
                action: "delivered",
                outcome: "success",
                deliveryKey: "sch_smoke:1893553440000",
                timeCreated: 2,
              },
            ],
          })
        return fallback(request)
      }) as typeof globalThis.fetch,
    async ({ api, render }) => {
      api.route.navigate("session", { sessionID })
      await waitFor(() => api.state.session.get(sessionID) !== undefined)
      const opened = api.keymap.dispatchCommand("reminder.list")
      if (!opened.ok) throw new Error(JSON.stringify(opened))
      await waitFor(async () => (await render()).includes("Daily reflection"))
      expect(await render()).toContain("Reminders")

      const paused = api.keymap.dispatchCommand("dialog.reminder.pause")
      if (!paused.ok) throw new Error(JSON.stringify(paused))
      await waitFor(() => requests.some((request) => request.method === "PATCH" && request.path === "/reminder/sch_smoke"))
      await waitFor(async () => (await render()).includes("paused"))

      const audited = api.keymap.dispatchCommand("dialog.reminder.audit")
      if (!audited.ok) throw new Error(JSON.stringify(audited))
      await waitFor(() => requests.some((request) => request.path === "/reminder/sch_smoke/audit"))
      await waitFor(async () => (await render()).includes("delivered · success"))
      expect(await render()).toContain("sch_smoke:1893553440000")
      const reminderRequests = requests.filter((request) => request.path.startsWith("/reminder"))
      expect(reminderRequests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "GET /reminder",
        "PATCH /reminder/sch_smoke",
        "GET /reminder/sch_smoke/audit",
      ])
      expect(reminderRequests.every((request) => (request.workspace ?? request.legacyWorkspace) === "personal")).toBe(true)
      expect(
        reminderRequests.every((request) => new URLSearchParams(request.query).get("session") === sessionID),
      ).toBe(true)
    },
  )
}, 20_000)

test("reviews, approves, audits, and revokes a Continuity grant through the full TUI", async () => {
  const requests: RecordedRequest[] = []
  let status: "proposed" | "active" | "revoked" = "proposed"
  const audits = [
    {
      id: "cga_proposed",
      grantID: "cgr_smoke",
      action: "proposed",
      outcome: "success",
      timeCreated: Date.parse("2030-01-01T00:00:00Z"),
    },
  ]
  const continuity = () => ({
    id: "cgr_smoke",
    sourceWorkspaceID: "personal",
    sourceDirectory: directory,
    sourceProfileID: "assistant",
    sourceSessionID: sessionID,
    destinationWorkspaceID: "personal",
    destinationDirectory: directory,
    destinationProfileID: "companion",
    destinationSessionID: "ses_companion",
    purpose: "Continue travel planning",
    summary: "The user approved this minimized travel summary.",
    relationshipPersistence: false,
    timeExpires: Date.parse("2030-01-02T03:04:00Z"),
    status,
    timeCreated: 1,
    timeUpdated: 1,
  })

  await withTui(
    (fallback) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          workspace: url.searchParams.get("workspace") ?? undefined,
          legacyWorkspace: request.headers.get("x-opencode-workspace") ?? undefined,
        })
        if (url.pathname === "/session" && request.method === "GET") return Response.json([session, secondSession])
        if (url.pathname === `/session/${sessionID}`) return Response.json(session)
        if (url.pathname === `/session/${secondSessionID}`) return Response.json(secondSession)
        if (
          url.pathname === `/session/${sessionID}/message` ||
          url.pathname === `/session/${sessionID}/todo` ||
          url.pathname === `/session/${sessionID}/diff` ||
          url.pathname === `/session/${secondSessionID}/message` ||
          url.pathname === `/session/${secondSessionID}/todo` ||
          url.pathname === `/session/${secondSessionID}/diff`
        )
          return Response.json([])
        if (url.pathname === "/continuity-grant" && request.method === "GET") return Response.json([continuity()])
        if (url.pathname === "/continuity-grant/cgr_smoke" && request.method === "GET")
          return Response.json(continuity())
        if (url.pathname === "/continuity-grant/cgr_smoke/audit" && request.method === "GET")
          return Response.json(audits)
        if (url.pathname === "/continuity-grant/cgr_smoke/approve" && request.method === "POST") {
          status = "active"
          audits.push({
            id: "cga_approved",
            grantID: "cgr_smoke",
            action: "approved",
            outcome: "success",
            timeCreated: Date.parse("2030-01-01T00:01:00Z"),
          })
          return Response.json(continuity())
        }
        if (url.pathname === "/continuity-grant/cgr_smoke/revoke" && request.method === "POST") {
          status = "revoked"
          audits.push({
            id: "cga_revoked",
            grantID: "cgr_smoke",
            action: "revoked",
            outcome: "success",
            timeCreated: Date.parse("2030-01-01T00:02:00Z"),
          })
          return Response.json(continuity())
        }
        return fallback(request)
      }) as typeof globalThis.fetch,
    async ({ api, events, mockInput, render }) => {
      api.keymap.dispatchCommand("continuity.list")
      await render()
      expect(requests.filter((request) => request.path.startsWith("/continuity-grant"))).toEqual([])

      await waitFor(() => api.state.ready)
      api.route.navigate("session", { sessionID })
      await waitFor(
        async () => {
          await render()
          return api.state.session.get(sessionID) !== undefined
        },
        5000,
        () => requests.filter((request) => request.path.startsWith("/session")),
      )
      await waitFor(
        () =>
          ["message", "todo", "diff"].every((suffix) =>
            requests.some((request) => request.path === `/session/${sessionID}/${suffix}`),
          ),
        5000,
        () => requests.filter((request) => request.path.startsWith(`/session/${sessionID}`)),
      )
      const backgroundReads = requests.filter(
        (request) =>
          request.path === `/session/${sessionID}/message` ||
          request.path === `/session/${sessionID}/todo` ||
          request.path === `/session/${sessionID}/diff`,
      ).length

      const opened = api.keymap.dispatchCommand("continuity.list")
      if (!opened.ok) throw new Error(JSON.stringify(opened))
      let continuityFrame = ""
      await waitFor(
        async () => {
          continuityFrame = await render()
          return (
            continuityFrame.includes("Continue travel planning") &&
            !continuityFrame.includes("Loading Continuity grants")
          )
        },
        5000,
        () => ({
          dialog: { open: api.ui.dialog.open, depth: api.ui.dialog.depth },
          route: api.route.current,
          sourceSession: api.state.session.get(sessionID),
          grantRequests: requests.filter((request) => request.path.startsWith("/continuity-grant")),
          frame: continuityFrame,
        }),
      )
      expect(await render()).toContain("not persisted to relationship Memory")
      expect(requests.filter((request) => request.method === "GET" && request.path === "/continuity-grant")).toEqual([
        expect.objectContaining({
          query: expect.stringContaining(`session=${sessionID}`),
          workspace: "personal",
          legacyWorkspace: undefined,
        }),
      ])

      const detail = api.keymap.dispatchCommand("dialog.select.submit")
      if (!detail.ok) throw new Error(JSON.stringify(detail))
      let detailFrame = ""
      await waitFor(
        async () => {
          detailFrame = await render()
          return requests.some((request) => request.path.endsWith("/audit"))
        },
        5000,
        () => ({
          dialog: { open: api.ui.dialog.open, depth: api.ui.dialog.depth },
          grantRequests: requests.filter((request) => request.path.startsWith("/continuity-grant")),
          route: api.route.current,
          sourceSession: api.state.session.get(sessionID),
          frame: detailFrame,
        }),
      )
      let summaryFrame = ""
      await waitFor(
        async () => {
          summaryFrame = await render()
          return summaryFrame.includes("The user approved this minimized travel summary.")
        },
        5000,
        () => {
          const current = api.route.current
          const source = api.state.session.get(sessionID)
          return {
            dialogOpen: api.ui.dialog.open,
            dialogDepth: api.ui.dialog.depth,
            routeType: current.name,
            routeSessionID:
              current.name === "session" && typeof current.params?.sessionID === "string"
                ? current.params.sessionID
                : undefined,
            sourceWorkspaceID: source?.workspaceID,
            sourceDirectory: source?.directory,
            grantRequests: requests.filter((request) => request.path.startsWith("/continuity-grant")),
            frame: summaryFrame,
          }
        },
      )

      mockInput.pressKey("HOME")
      await render()
      mockInput.pressKey("a", { meta: true })
      let approveFrame = ""
      await waitFor(
        async () => {
          approveFrame = await render()
          return approveFrame.includes("Approve continuity grant")
        },
        5000,
        () => ({
          dialog: { open: api.ui.dialog.open, depth: api.ui.dialog.depth },
          grantRequests: requests.filter((request) => request.path.startsWith("/continuity-grant")),
          frame: approveFrame,
        }),
      )
      await render()
      mockInput.pressEnter()
      await waitFor(
        async () => {
          await render()
          return requests.some((request) => request.path.endsWith("/approve"))
        },
        5000,
        () => ({
          dialog: { open: api.ui.dialog.open, depth: api.ui.dialog.depth },
          route: api.route.current,
          sourceSession: api.state.session.get(sessionID),
          grantRequests: requests.filter((request) => request.path.startsWith("/continuity-grant")),
          frame: approveFrame,
        }),
      )
      await waitFor(async () => {
        const frame = await render()
        const auditReloads = requests.filter((request) => request.path.endsWith("/audit")).length
        return frame.includes("active") && auditReloads >= 2
      })

      mockInput.pressKey("r", { meta: true })
      await waitFor(async () => (await render()).includes("Revoke continuity grant"))
      mockInput.pressEnter()
      await waitFor(async () => {
        await render()
        return requests.some((request) => request.path.endsWith("/revoke"))
      })
      await waitFor(async () => {
        const frame = await render()
        const auditReloads = requests.filter((request) => request.path.endsWith("/audit")).length
        return frame.includes("revoked") && auditReloads >= 3
      })

      expect(
        requests
          .filter((request) => request.path.startsWith("/continuity-grant"))
          .map((request) => ({
            method: request.method,
            path: request.path,
            session: new URLSearchParams(request.query).get("session"),
            workspace: request.workspace,
          })),
      ).toEqual([
        { method: "GET", path: "/continuity-grant", session: sessionID, workspace: "personal" },
        { method: "GET", path: "/continuity-grant/cgr_smoke", session: sessionID, workspace: "personal" },
        { method: "GET", path: "/continuity-grant/cgr_smoke/audit", session: sessionID, workspace: "personal" },
        { method: "POST", path: "/continuity-grant/cgr_smoke/approve", session: sessionID, workspace: "personal" },
        { method: "GET", path: "/continuity-grant/cgr_smoke", session: sessionID, workspace: "personal" },
        { method: "GET", path: "/continuity-grant/cgr_smoke/audit", session: sessionID, workspace: "personal" },
        { method: "POST", path: "/continuity-grant/cgr_smoke/revoke", session: sessionID, workspace: "personal" },
        { method: "GET", path: "/continuity-grant/cgr_smoke", session: sessionID, workspace: "personal" },
        { method: "GET", path: "/continuity-grant/cgr_smoke/audit", session: sessionID, workspace: "personal" },
      ])
      expect(
        requests.filter(
          (request) =>
            request.path === `/session/${sessionID}/message` ||
            request.path === `/session/${sessionID}/todo` ||
            request.path === `/session/${sessionID}/diff`,
        ).length,
      ).toBe(backgroundReads)
      expect(
        requests.some(
          (request) =>
            request.path.includes("history") ||
            request.path.includes("file-content") ||
            request.path.includes("file-search") ||
            request.path === "/file",
        ),
      ).toBe(false)

      api.route.navigate("session", { sessionID: secondSessionID })
      await waitFor(() => !api.ui.dialog.open)
    },
  )
}, 20_000)
