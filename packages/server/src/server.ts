import { createApp, type App, type AppConfig, type PromptResult, type SessionRow, type RegistryQuery, type AuditEventRow } from "@newhorse/runtime"
import type { AdapterConfig } from "@newhorse/llm"
import type { StoredEvent, ApprovalRequest } from "@newhorse/schema"

/**
 * Runtime server (Phase 1): transport-only HTTP + SSE boundary over `createApp`.
 *
 * Per AGENTS.md, the server holds NO domain logic — it parses HTTP, maps
 * endpoints to `App` members, and streams `LoopEvent`s. All session/agent/llm
 * concerns live in the runtime.
 *
 * Sessions are held in a process-local map (sessionId → App); `POST /session`
 * creates or attaches. Multiple sessions run in parallel; each `App` is one
 * durable session attached to a workspace.
 */

/** Server configuration (transport concerns only). */
export interface ServerConfig {
  /** Host to bind. Default 127.0.0.1 (loopback-only). */
  readonly host?: string
  /** Port to bind. Default 3927. */
  readonly port?: number
  /**
   * Optional bearer token. When set, every request must carry
   * `Authorization: Bearer <token>` (constant-time compare). When absent,
   * only loopback binds are accepted.
   */
  readonly token?: string
  /** Per-session configuration factory — how to build an App for a workspace. */
  readonly sessionConfig?: (
    create: SessionCreateRequest,
  ) => Promise<AppConfig> | AppConfig
  /** Transport-injected approval gate (M4 execpolicy). Absent → fail-closed. */
  readonly onApprove?: (req: ApprovalRequest) => Promise<boolean>
  /** Pluggable session routing (default: process-local Map). */
  readonly sessionResolver?: SessionResolver
}

/** One session's create config (POST /v1/session body), transport DTO. */
export interface SessionCreateRequest {
  readonly workspace?: string
  readonly sessionId?: string
  readonly model?: string
  readonly provider?: AdapterConfig
  readonly enableBash?: boolean
  readonly pluginsDir?: string
  readonly dataDir?: string
  readonly tools?: ReadonlyArray<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
}

/**
 * Pluggable session resolver — consulted when a session id is NOT in the
 * server's local map (a host may lazily re-attach sessions from disk, proxy
 * to another node, etc.). Default: absent → local map only.
 */
export type SessionResolver = (sessionId: string) => Promise<App | undefined> | App | undefined

export interface ServerHandle {
  /** Base URL to reach this server (e.g. http://127.0.0.1:3927). */
  readonly baseUrl: string
  /** Read a session (test/debug helper). */
  readonly appFor: (sessionId: string) => App | undefined
  readonly stop: () => Promise<void>
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bearer(req: Request): string | undefined {
  const auth = req.headers.get("authorization")
  if (!auth || !auth.startsWith("Bearer ")) return undefined
  return auth.slice(7)
}

async function readJson<T>(req: Request): Promise<T | undefined> {
  try {
    const text = await req.text()
    if (!text) return undefined
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** Read a JSON body; a malformed (non-JSON) body is a client error, not a no-op. */
async function readJsonOr400<T>(req: Request): Promise<T | { error: string }> {
  try {
    const text = await req.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  } catch {
    return { error: "malformed JSON body" }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** SSE stream: one `data: {json}\n\n` per event; `[DONE]` at the end. */
function sseStream(): { stream: ReadableStream<Uint8Array>; emit: (payload: string) => void; close: () => void } {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      // Client disconnected (browser nav / network drop / curl abort). Further
      // enqueue/close must be a no-op, not a throw — an unhandled rejection in
      // the prompt .then() would crash the whole Bun process.
      closed = true
    },
  })
  return {
    stream,
    emit: (payload) => {
      if (closed) return
      try {
        controller.enqueue(encoder.encode(payload))
      } catch {
        closed = true
      }
    },
    close: () => {
      if (closed) return
      closed = true
      try {
        controller.close()
      } catch {
        // already closed by the client; no-op.
      }
    },
  }
}

export async function createServer(config: ServerConfig): Promise<ServerHandle> {
  const host = config.host ?? "127.0.0.1"
  const port = config.port ?? 3927
  const token = config.token
  const sessionResolver = config.sessionResolver
  const apps = new Map<string, App>()
  /** apps map first; on a miss, consult the pluggable resolver (a host may
   *  lazily re-attach sessions from disk or proxy from another node). */
  const findApp = async (sessionId: string): Promise<{ app: App; error?: undefined } | { app: undefined; error: string }> => {
    const local = apps.get(sessionId)
    if (local) return { app: local }
    if (!sessionResolver) return { app: undefined, error: `session "${sessionId}" not found` }
    // A host-provided resolver may lazily re-attach sessions (from disk, from
    // another node, etc.) — cache the result to avoid repeated resolution.
    const resolved = await sessionResolver(sessionId)
    if (resolved) { apps.set(sessionId, resolved); return { app: resolved } }
    return { app: undefined, error: `session "${sessionId}" not found` }
  }
  const sessionConfig = config.sessionConfig

  /** Build (or return cached) an App for a session id. */
  async function resolveApp(create: SessionCreateRequest): Promise<App | undefined> {
    const id = create.sessionId ?? crypto.randomUUID()
    const existing = apps.get(id)
    if (existing) return existing
    if (!sessionConfig) return undefined
    const base = await sessionConfig({ ...create })
    // sessionId must be pinned, else createApp derives a workspace-stable id
    // that differs from the one the caller will use in paths.
    const app = await createApp({ ...base, sessionId: id, onApprove: config.onApprove })
    apps.set(id, app)
    return app
  }

  /** SSE prompt: subscribe once, stream loop events, then result + [DONE].
   *  Client disconnect (req.signal) interrupts the app so the stream shuts
   *  down cleanly instead of leaving a half-open SSE connection — Bun's
   *  server.stop() would otherwise crash on a pending disconnected stream. */
  async function promptStream(app: App, text: string, principal?: "user" | "butler" | "parent", signal?: AbortSignal): Promise<Response> {
    const sse = sseStream()
    const unsubscribe = app.onEvent((event) => {
      sse.emit(`data: ${JSON.stringify(event)}\n\n`)
    })
    // Client went away → cancel the run. The loop settles as interrupted;
    // further emit/close are no-ops on the closed controller.
    const onAbort = (): void => app.interrupt()
    signal?.addEventListener("abort", onAbort, { once: true })
    app
      .prompt(text, principal)
      .then((result) => {
        sse.emit(`data: ${JSON.stringify({ type: "result", ...result })}\n\n`)
        sse.emit(`data: [DONE]\n\n`)
        sse.close()
      })
      .catch((err: unknown) => {
        sse.emit(`data: ${JSON.stringify({ type: "error", code: "server", message: err instanceof Error ? err.message : String(err) })}\n\n`)
        sse.emit(`data: [DONE]\n\n`)
        sse.close()
      })
      .finally(() => {
        signal?.removeEventListener("abort", onAbort)
        unsubscribe()
      })
    return new Response(sse.stream, { headers: { "content-type": "text/event-stream" } })
  }

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      // Token gate (constant-time). Without a token, only loopback binds.
      if (token) {
        if (!constantTimeEqual(bearer(req) ?? "", token)) return json(401, { error: "unauthorized" })
      } else if (host !== "127.0.0.1" && host !== "::1") {
        return json(403, { error: "loopback-only (no token; bind 127.0.0.1 or provide token)" })
      }

      const url = new URL(req.url)
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts[0] !== "v1") return json(404, { error: "not found" })

      const method = req.method

      // GET /v1/health
      if (method === "GET" && parts.length === 2 && parts[1] === "health") {
        return json(200, { status: "ok" })
      }

      // POST /v1/session
      if (method === "POST" && parts.length === 2 && parts[1] === "session") {
        const parsed = await readJsonOr400<SessionCreateRequest>(req)
        if ("error" in parsed) return json(400, parsed)
        const app = await resolveApp(parsed)
        if (!app) return json(500, { error: "no sessionConfig provided; cannot create session" })
        const session = await app.resume()
        return json(201, { sessionId: app.sessionId, messageCount: session.messages.length, headSeq: session.headSeq })
      }

      // POST /v1/session/:id/prompt
      if (method === "POST" && parts.length === 4 && parts[3] === "prompt") {
        const found = await findApp(parts[2]!)
        if (!found.app) return json(404, { error: found.error })
        const parsed = await readJsonOr400<{ text?: string; principal?: "user" | "butler" | "parent" }>(req)
        if ("error" in parsed) return json(400, parsed)
        if (!parsed.text) return json(400, { error: "text is required" })
        return promptStream(found.app, parsed.text, parsed.principal, req.signal)
      }

      // POST /v1/session/:id/steer
      if (method === "POST" && parts.length === 4 && parts[3] === "steer") {
        const found = await findApp(parts[2]!)
        if (!found.app) return json(404, { error: found.error })
        const parsed = await readJsonOr400<{ text?: string }>(req)
        if ("error" in parsed) return json(400, parsed)
        if (!parsed.text) return json(400, { error: "text is required" })
        await found.app.steer(parsed.text)
        return json(200, { admitted: true })
      }

      // POST /v1/session/:id/interrupt
      if (method === "POST" && parts.length === 4 && parts[3] === "interrupt") {
        const found = await findApp(parts[2]!)
        if (!found.app) return json(404, { error: found.error })
        found.app.interrupt()
        return json(200, { interrupted: true })
      }

      // GET /v1/session/:id
      if (method === "GET" && parts.length === 3) {
        const found = await findApp(parts[2]!)
        if (!found.app) return json(404, { error: found.error })
        // Session is serializable; its snapshot (messages/headSeq) is the API shape.
        const session = await found.app.resume()
        return json(200, session.snapshot())
      }

      // GET /v1/sessions
      if (method === "GET" && parts.length === 2 && parts[1] === "sessions") {
        const ws = url.searchParams.get("workspace") ?? undefined
        const st = url.searchParams.get("status") ?? undefined
        const query: RegistryQuery = ws || st ? { ...(ws ? { workspace: ws } : {}), ...(st ? { status: st as RegistryQuery["status"] } : {}) } : {}
        const rows: SessionRow[] = []
        for (const app of apps.values()) rows.push(...(await app.listSessions(query)))
        // de-dup by sessionId (same session can appear once per App but Apps are 1:1)
        const seen = new Set<string>()
        return json(200, rows.filter((r) => !seen.has(r.sessionId) && seen.add(r.sessionId)))
      }

      // GET /v1/audit
      if (method === "GET" && parts.length === 2 && parts[1] === "audit") {
        const actor = url.searchParams.get("actorSessionId") ?? undefined
        const rows: AuditEventRow[] = []
        for (const app of apps.values()) rows.push(...(await app.audit(actor)))
        return json(200, rows)
      }

      // GET /v1/session/:id/events
      if (method === "GET" && parts.length === 4 && parts[3] === "events") {
        const found = await findApp(parts[2]!)
        if (!found.app) return json(404, { error: found.error })
        const events: StoredEvent[] = await found.app.events.read(parts[2]!)
        return json(200, events)
      }

      return json(404, { error: "not found" })
    },
  })

  const handle: ServerHandle = {
    baseUrl: `http://${host}:${server.port}`,
    appFor: (id) => apps.get(id),
    stop: async () => {
      // Interrupt any in-flight prompt BEFORE closing the event store — a
      // live stream would keep emitting into a closed controller/store.
      for (const app of apps.values()) app.interrupt()
      // Wait a tick so the interrupted prompt's settle path lands before the
      // store closes (best-effort; a fully idle server has no in-flight work).
      await new Promise((r) => setTimeout(r, 20))
      server.stop()
      for (const app of apps.values()) {
        // SqliteEventStore has close(); the EventStore interface doesn't.
        (app.events as { close?: () => void }).close?.()
      }
    },
  }
  return handle
}
