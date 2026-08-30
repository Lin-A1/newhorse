import { createApp, type App, type AppConfig, type PromptResult, type SessionRow, type RegistryQuery, type AuditEventRow, type SessionDirectory, type DirectoryEntry, type SettingsController, type AgentHomeConfig, type ApprovalHub, type Scheduler, type ScheduleInput, type Schedule } from "@newhorse/runtime"
import { redactSettings, aggregateUsage } from "@newhorse/runtime"
import { listModels } from "@newhorse/llm"
import type { AdapterConfig, Fetcher } from "@newhorse/llm"
import type { StoredEvent, ApprovalRequest } from "@newhorse/schema"
import { join } from "node:path"

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
 *
 * Cross-process routing (M4, optional): when a `directory` is configured,
 * sessions created here are REGISTERED with this server's URL, so a sibling
 * server process can interrupt/steer/observe them by proxying over HTTP —
 * and vice versa (a miss in the local map resolves through the directory).
 * The directory is one shared SQLite file (see createSqliteSessionDirectory).
 */

/** Server configuration (transport concerns only). */
export interface ServerConfig {
  /** Host to bind. Default 127.0.0.1 (loopback-only). */
  readonly host?: string
  /** Port to bind. Default 3927. */
  readonly port?: number
  /**
   * Socket idle timeout in seconds (Bun default 10 kills SSE streams that go
   * quiet during long tool executions). Default 120; a 15s SSE keepalive
   * comment also runs on every prompt stream, so only pathological gaps
   * depend on this.
   */
  readonly idleTimeout?: number
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
  /** Pluggable session resolver (host lazy re-attach). */
  readonly sessionResolver?: SessionResolver
  /**
   * Cross-process live-session directory. When set, owned sessions are
   * registered so sibling processes can reach them, and sessions owned by
   * siblings are proxied on a local-map miss. Heartbeats keep ownership
   * alive; stop() unregisters everything this process created.
   */
  readonly directory?: SessionDirectory
  /** URL other processes use to reach THIS server (default: derived baseUrl). */
  readonly advertiseUrl?: string
  /** Directory with the built client UI (index.html + assets). When set, all
   *  non-/v1 GET paths serve it with SPA fallback — one origin for API + UI:
   *  standalone web, LAN mobile, and the desktop webview are the same artifact. */
  readonly uiDir?: string
  /** Settings surface for the client's settings page (read effective / write patch). */
  readonly settings?: SettingsController
  /** Interactive approval hub: the engine's gate parks requests here and the
   *  client settles them via /v1/approvals. When present it is the DEFAULT
   *  gate for created sessions (an explicit onApprove still wins). */
  readonly approvals?: ApprovalHub
  /** Scheduled prompts (定时任务). CRUD via /v1/schedules; the caller owns the
   *  tick loop (the standalone entrypoint starts one; a host may use its own). */
  readonly schedules?: Scheduler
  /** Injectable fetch for the provider models listing (tests). */
  readonly modelsFetch?: Fetcher
}

/** One session's create config (POST /v1/session body), transport DTO. */
export interface SessionCreateRequest {
  readonly workspace?: string
  readonly sessionId?: string
  readonly model?: string
  /** The create-model's context window in tokens (scales auto-compaction). */
  readonly contextWindowTokens?: number
  /** Output budget per reply in tokens (avoids the anthropic 4096 floor). */
  readonly maxOutputTokens?: number
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
  /** Fire-and-forget a user prompt into a session (get-or-create) — the
   *  scheduled-prompts delivery path; the prompt lands in the durable inbox. */
  readonly admitPrompt: (sessionId: string, prompt: string) => Promise<void>
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

/** Serve the built client UI with SPA fallback. Path traversal is blocked by
 *  requiring the resolved path to stay under root (root+sep compare). */
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json" }
async function serveStatic(root: string, pathname: string): Promise<Response> {
  const normalizedRoot = root.replace(/[\\/]+$/, "") + "/"
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1))
  const resolved = join(root, rel)
  if (!resolved.replace(/[\\/]+$/, "").startsWith(normalizedRoot.replace(/[\\/]+$/, ""))) return json(403, { error: "forbidden" })
  const file = Bun.file(resolved)
  if (await file.exists()) {
    const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase()
    return new Response(file, { headers: CONTENT_TYPES[ext] ? { "content-type": CONTENT_TYPES[ext]! } : {} })
  }
  // SPA fallback: unknown extension-less paths load the app shell.
  if (!rel.includes(".")) {
    const index = Bun.file(join(root, "index.html"))
    if (await index.exists()) return new Response(index, { headers: { "content-type": CONTENT_TYPES[".html"]! } })
  }
  return json(404, { error: "not found" })
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
  const directory = config.directory
  const settings = config.settings
  const approvals = config.approvals
  const schedules = config.schedules
  const apps = new Map<string, App>()
  /** Sessions this process created (directory-owned; unregistered on stop). */
  const owned = new Set<string>()

  /** The URL peers use to reach this server (advertised or derived). Trailing
   *  slashes are stripped so endpoint comparisons (stale-self guard) can't be
   *  defeated by spelling. */
  const selfUrl = (): string => (config.advertiseUrl ?? `http://${host}:${server.port}`).replace(/\/+$/, "")

  /** Independent liveness probe for a proxy failure: only a failed HEALTH
   *  CHECK (not a slow response, not our own client's disconnect) may sweep a
   *  directory row — the owner re-asserts its row on the next heartbeat tick
   *  anyway, but a wrong sweep would open a split-brain window. */
  async function ownerAlive(entry: DirectoryEntry): Promise<boolean> {
    try {
      const headers: Record<string, string> = {}
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch(`${entry.endpoint}/v1/health`, { headers, signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** A resolved session: served locally, owned by a sibling process, or absent. */
  type Found = { kind: "local"; app: App } | { kind: "remote"; entry: DirectoryEntry } | { kind: "missing"; error: string }
  const findSession = async (sessionId: string): Promise<Found> => {
    const local = apps.get(sessionId)
    if (local) return { kind: "local", app: local }
    if (directory) {
      const entry = directory.lookup(sessionId)
      if (entry) {
        if (entry.endpoint === selfUrl()) {
          // Stale self-entry (we ARE that endpoint but hold no app — the owner
          // restarted). Sweep it rather than proxying to ourselves.
          directory.unregister(sessionId)
        } else {
          return { kind: "remote", entry }
        }
      }
    }
    if (sessionResolver) {
      // A host-provided resolver may lazily re-attach sessions (from disk,
      // from another node, etc.) — cache the result to avoid repeated resolution.
      const resolved = await sessionResolver(sessionId)
      if (resolved) {
        apps.set(sessionId, resolved)
        // We now HOLD this session locally and the directory had no live row
        // — claim ownership so cross-process ops route here.
        if (directory) {
          directory.register(sessionId, selfUrl())
          owned.add(sessionId)
        }
        return { kind: "local", app: resolved }
      }
    }
    return { kind: "missing", error: `session "${sessionId}" not found` }
  }

  /** Proxy a JSON op to the owning server. Owner confirmed dead (health probe
   *  fails) → sweep the stale entry (self-healing directory) and report 502. */
  async function proxyJson(entry: DirectoryEntry, path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
    if (token) headers.authorization = `Bearer ${token}`
    try {
      const res = await fetch(entry.endpoint + path, { ...init, headers, signal: AbortSignal.timeout(5000) })
      return new Response(await res.arrayBuffer(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })
    } catch {
      if (!init?.signal?.aborted && !(await ownerAlive(entry))) {
        directory?.unregister(entry.sessionId)
        return json(502, { error: `owner ${entry.endpoint} unreachable for session "${entry.sessionId}" (stale entry swept)` })
      }
      return json(502, { error: `owner ${entry.endpoint} unreachable for session "${entry.sessionId}"` })
    }
  }

  /** Proxy the SSE prompt stream: relay the owner's event stream verbatim.
   *  The client's own disconnect (signal aborted) is NOT an owner failure —
   *  never sweep for it. */
  async function proxyPrompt(entry: DirectoryEntry, sessionId: string, body: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    try {
      const res = await fetch(`${entry.endpoint}/v1/session/${sessionId}/prompt`, { method: "POST", headers, body, signal })
      return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream" } })
    } catch {
      if (!signal?.aborted && !(await ownerAlive(entry))) {
        directory?.unregister(entry.sessionId)
        return json(502, { error: `owner ${entry.endpoint} unreachable for session "${entry.sessionId}" (stale entry swept)` })
      }
      return json(502, { error: `owner ${entry.endpoint} unreachable for session "${entry.sessionId}"` })
    }
  }
  const sessionConfig = config.sessionConfig

  type ResolveResult = { app: App; conflict?: undefined } | { app?: undefined; conflict: DirectoryEntry } | undefined

  /** Build (or return cached) an App for a session id. */
  async function resolveApp(create: SessionCreateRequest): Promise<ResolveResult> {
    const id = create.sessionId ?? crypto.randomUUID()
    const existing = apps.get(id)
    if (existing) {
      // Re-assert ownership on a local hit (idempotent, refreshes heartbeat):
      // a proxy blip may have swept our row while the session is alive HERE —
      // restoring it keeps the owner-only-writer invariant honest (only the
      // holder writes its row).
      if (directory) {
        directory.register(id, selfUrl())
        owned.add(id)
      }
      return { app: existing }
    }
    if (!sessionConfig) return undefined
    const base = await sessionConfig({ ...create })
    // sessionId must be pinned, else createApp derives a workspace-stable id
    // that differs from the one the caller will use in paths.
    const app = await createApp({ ...base, sessionId: id, onApprove: config.onApprove ?? config.approvals?.gate })
    if (directory) {
      // Register cross-process ownership. register returns the PREVIOUS row:
      // a foreign FRESH row means a sibling owns this id and our pre-check
      // raced — give the row back, discard the local App (two Apps must never
      // drive one log) and report the conflict. A STALE foreign row (dead
      // owner past the heartbeat window) is a legitimate takeover.
      const previous = directory.register(id, selfUrl())
      if (previous && previous.endpoint !== selfUrl() && Date.now() - previous.heartbeatAt < 30_000) {
        directory.register(id, previous.endpoint, previous.pid)
        void (app.events as { close?: () => void }).close?.()
        return { conflict: previous }
      }
      owned.add(id)
    }
    apps.set(id, app)
    return { app }
  }

  /** SSE prompt: subscribe once, stream loop events, then result + [DONE].
   *  Client disconnect (req.signal) interrupts the app so the stream shuts
   *  down cleanly instead of leaving a half-open SSE connection — Bun's
   *  server.stop() would otherwise crash on a pending disconnected stream. */
  let inFlight = 0
  async function promptStream(app: App, text: string, principal?: "user" | "butler" | "parent", signal?: AbortSignal): Promise<Response> {
    inFlight++
    const sse = sseStream()
    // Flush headers NOW with an SSE comment line: Bun does not send response
    // headers until the first body byte, and a turn can go quiet for a long
    // time (hung LLM, long tool) — clients and cross-process proxies must see
    // the 200 immediately, not at the first event.
    sse.emit(": open\n\n")
    // Keepalive comments every 15s: a turn running a long tool emits no
    // events, and an idle socket would be dropped (Bun default 10s). Comment
    // lines are ignored by every SSE client, so they are safe between events.
    const keepalive = setInterval(() => sse.emit(": keepalive\n\n"), 15_000)
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
        inFlight--
        clearInterval(keepalive)
        signal?.removeEventListener("abort", onAbort)
        unsubscribe()
      })
    return new Response(sse.stream, { headers: { "content-type": "text/event-stream" } })
  }

  const server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: config.idleTimeout ?? 120,
    async fetch(req) {
      // Token gate (constant-time). Without a token, only loopback binds.
      if (token) {
        if (!constantTimeEqual(bearer(req) ?? "", token)) return json(401, { error: "unauthorized" })
      } else if (host !== "127.0.0.1" && host !== "::1") {
        return json(403, { error: "loopback-only (no token; bind 127.0.0.1 or provide token)" })
      }

      const url = new URL(req.url)
      const parts = url.pathname.split("/").filter(Boolean)
      const method = req.method
      // The built client UI (SPA) — one origin with the API.
      if (parts[0] !== "v1") {
        if (config.uiDir && method === "GET") return serveStatic(config.uiDir, url.pathname)
        return json(404, { error: "not found" })
      }

      // GET /v1/health
      if (method === "GET" && parts.length === 2 && parts[1] === "health") {
        return json(200, { status: "ok" })
      }

      // POST /v1/session
      if (method === "POST" && parts.length === 2 && parts[1] === "session") {
        const parsed = await readJsonOr400<SessionCreateRequest>(req)
        if ("error" in parsed) return json(400, parsed)
        // Split-brain guard: an explicit id that a SIBLING process owns must
        // not be re-created locally (two Apps would drive one log). The
        // register-time takeover check in resolveApp closes the remaining
        // check-then-act race.
        if (parsed.sessionId && directory) {
          const entry = directory.lookup(parsed.sessionId)
          if (entry && entry.endpoint !== selfUrl() && Date.now() - entry.heartbeatAt < 30_000) return json(409, { error: `session "${parsed.sessionId}" is owned by ${entry.endpoint}` })
        }
        const resolved = await resolveApp(parsed)
        if (!resolved) return json(500, { error: "no sessionConfig provided; cannot create session" })
        if (resolved.conflict) return json(409, { error: `session "${parsed.sessionId}" is owned by ${resolved.conflict.endpoint}` })
        const session = await resolved.app.resume()
        return json(201, { sessionId: resolved.app.sessionId, messageCount: session.messages.length, headSeq: session.headSeq })
      }

      // POST /v1/session/:id/prompt
      if (method === "POST" && parts.length === 4 && parts[3] === "prompt") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        const parsed = await readJsonOr400<{ text?: string; principal?: "user" | "butler" | "parent" }>(req)
        if ("error" in parsed) return json(400, parsed)
        if (!parsed.text) return json(400, { error: "text is required" })
        if (found.kind === "remote") return proxyPrompt(found.entry, parts[2]!, JSON.stringify({ text: parsed.text, principal: parsed.principal }), req.signal)
        return promptStream(found.app, parsed.text, parsed.principal, req.signal)
      }

      // POST /v1/session/:id/steer
      if (method === "POST" && parts.length === 4 && parts[3] === "steer") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        const parsed = await readJsonOr400<{ text?: string }>(req)
        if ("error" in parsed) return json(400, parsed)
        if (!parsed.text) return json(400, { error: "text is required" })
        if (found.kind === "remote") return proxyJson(found.entry, `/v1/session/${parts[2]!}/steer`, { method: "POST", body: JSON.stringify({ text: parsed.text }) })
        await found.app.steer(parsed.text)
        return json(200, { admitted: true })
      }

      // POST /v1/session/:id/interrupt
      if (method === "POST" && parts.length === 4 && parts[3] === "interrupt") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return proxyJson(found.entry, `/v1/session/${parts[2]!}/interrupt`, { method: "POST" })
        found.app.interrupt()
        return json(200, { interrupted: true })
      }

      // GET /v1/session/:id
      if (method === "GET" && parts.length === 3) {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return proxyJson(found.entry, `/v1/session/${parts[2]!}`)
        // Session is serializable; its snapshot (messages/headSeq) is the API shape.
        const session = await found.app.resume()
        return json(200, session.snapshot())
      }

      // GET /v1/live — the cross-process directory view (who owns what).
      if (method === "GET" && parts.length === 2 && parts[1] === "live") {
        return json(200, { self: selfUrl(), live: directory?.entries() ?? [] })
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
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return proxyJson(found.entry, `/v1/session/${parts[2]!}/events`)
        const events: StoredEvent[] = await found.app.events.read(parts[2]!)
        return json(200, events)
      }

      // --- client-facing surfaces (settings / models / approvals / usage / schedules) ---

      // GET /v1/settings — effective settings, secrets redacted.
      if (method === "GET" && parts.length === 2 && parts[1] === "settings") {
        if (!settings) return json(404, { error: "no settings controller configured" })
        return json(200, redactSettings(settings.get()))
      }

      // PUT /v1/settings — merge a patch into the agent-home config file.
      if (method === "PUT" && parts.length === 2 && parts[1] === "settings") {
        if (!settings) return json(404, { error: "no settings controller configured" })
        const parsed = await readJsonOr400<AgentHomeConfig>(req)
        if ("error" in parsed) return json(400, parsed)
        const next = await settings.write(parsed)
        return json(200, redactSettings(next))
      }

      // GET /v1/models — the configured provider's available model ids.
      if (method === "GET" && parts.length === 2 && parts[1] === "models") {
        if (!settings) return json(404, { error: "no settings controller configured" })
        const provider: AdapterConfig = settings.get().provider
        const models = await listModels(provider, config.modelsFetch ?? globalThis.fetch.bind(globalThis))
        return json(200, { models })
      }

      // GET /v1/approvals — pending interactive approvals (the client polls).
      if (method === "GET" && parts.length === 2 && parts[1] === "approvals") {
        if (!approvals) return json(404, { error: "no approval hub configured" })
        return json(200, { approvals: approvals.pending() })
      }

      // POST /v1/approvals/:id {allow} — settle one pending approval.
      if (method === "POST" && parts.length === 3 && parts[1] === "approvals") {
        if (!approvals) return json(404, { error: "no approval hub configured" })
        const parsed = await readJsonOr400<{ allow?: boolean }>(req)
        if ("error" in parsed) return json(400, parsed)
        const settled = approvals.resolve(parts[2]!, parsed.allow === true)
        return json(settled ? 200 : 404, settled ? { settled: true } : { error: "unknown or already-settled approval id" })
      }

      // GET /v1/usage?days=N — per-day token totals (heatmap data).
      if (method === "GET" && parts.length === 2 && parts[1] === "usage") {
        if (!settings) return json(404, { error: "no settings controller configured" })
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30)))
        try {
          return json(200, await aggregateUsage(join(settings.get().dataDir, "events.db"), days))
        } catch (e) {
          // No events db yet (fresh install) — an empty summary, not an error.
          return json(200, { days: [], totals: { inputTokens: 0, outputTokens: 0, steps: 0 }, sessions: 0, note: e instanceof Error ? e.message : String(e) })
        }
      }

      // GET /v1/schedules — all scheduled prompts.
      if (method === "GET" && parts.length === 2 && parts[1] === "schedules") {
        if (!schedules) return json(404, { error: "no scheduler configured" })
        return json(200, { schedules: await schedules.list() })
      }

      // POST /v1/schedules — create a scheduled prompt.
      if (method === "POST" && parts.length === 2 && parts[1] === "schedules") {
        if (!schedules) return json(404, { error: "no scheduler configured" })
        const parsed = await readJsonOr400<ScheduleInput>(req)
        if ("error" in parsed) return json(400, parsed)
        try {
          const created: Schedule = await schedules.add(parsed)
          return json(201, created)
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) })
        }
      }

      // PATCH /v1/schedules/:id — update (enable/disable, change prompt/cadence).
      if (method === "PATCH" && parts.length === 3 && parts[1] === "schedules") {
        if (!schedules) return json(404, { error: "no scheduler configured" })
        const parsed = await readJsonOr400<Partial<ScheduleInput>>(req)
        if ("error" in parsed) return json(400, parsed)
        try {
          const updated = await schedules.update(parts[2]!, parsed)
          return updated ? json(200, updated) : json(404, { error: "unknown schedule id" })
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) })
        }
      }

      // DELETE /v1/schedules/:id
      if (method === "DELETE" && parts.length === 3 && parts[1] === "schedules") {
        if (!schedules) return json(404, { error: "no scheduler configured" })
        const removed = await schedules.remove(parts[2]!)
        return json(removed ? 200 : 404, removed ? { removed: true } : { error: "unknown schedule id" })
      }

      // POST /v1/schedules/:id/run — fire one schedule now.
      if (method === "POST" && parts.length === 4 && parts[1] === "schedules" && parts[3] === "run") {
        if (!schedules) return json(404, { error: "no scheduler configured" })
        const ok = await schedules.runNow(parts[2]!)
        return json(ok ? 200 : 404, ok ? { triggered: true } : { error: "unknown schedule id" })
      }

      return json(404, { error: "not found" })
    },
  })

  // Cross-process liveness: refresh this endpoint's heartbeat so siblings do
  // not sweep live sessions during long-running turns, and sweep rows whose
  // owner stopped heartbeating (crash / kill -9 — 30s = three missed ticks
  // plus event-loop stall margin). Unref'd — never holds the process open.
  const heartbeatTimer = directory ? setInterval(() => {
    try {
      directory.heartbeat(selfUrl())
      directory.sweep(30_000)
    } catch {
      // A transient lock/busy on the shared file is non-fatal — the next tick
      // refreshes; a persistently failed heartbeat surfaces via sweep.
    }
  }, 10_000) : undefined

  // Scheduled prompts (定时任务): when a scheduler is wired, the server owns a
  // 30s tick; each DUE schedule is fired through the scheduler's own `fire`
  // callback, which the host delegates to handle.admitPrompt (below).
  let scheduleTimer: ReturnType<typeof setInterval> | undefined
  if (schedules) {
    scheduleTimer = setInterval(() => {
      void schedules.tick().catch(() => {
        // A transient tick failure (lock, fs) is non-fatal — the next tick retries.
      })
    }, 30_000)
  }

  const admitPrompt = async (sessionId: string, prompt: string): Promise<void> => {
    const resolved = await resolveApp({ sessionId })
    const app = resolved?.app
    if (!app) throw new Error(`cannot attach session "${sessionId}" (no sessionConfig)`)
    void app.prompt(prompt, "user").catch(() => {
      // A failed fire is recorded by the scheduler's lastResult bookkeeping.
    })
  }

  const handle: ServerHandle = {
    baseUrl: `http://${host}:${server.port}`,
    appFor: (id) => apps.get(id),
    admitPrompt,
    stop: async () => {
      // Interrupt any in-flight prompt BEFORE closing the event store, then
      // wait (bounded) for them to settle — a late settle path would append
      // into a closed store.
      for (const app of apps.values()) app.interrupt()
      const deadline = Date.now() + 2000
      while (inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      server.stop()
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (scheduleTimer) clearInterval(scheduleTimer)
      // Release cross-process ownership for everything this process created.
      // Contention on the shared file must not skip the store shutdown below.
      if (directory) {
        for (const id of owned) {
          try {
            directory.unregister(id)
          } catch {
            // Heartbeat staleness sweep covers an un-unregistered row.
          }
        }
      }
      for (const app of apps.values()) {
        // SqliteEventStore has close(); the EventStore interface doesn't.
        (app.events as { close?: () => void }).close?.()
      }
    },
  }
  return handle
}
