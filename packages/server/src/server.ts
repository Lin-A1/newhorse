import { createApp, type App, type AppConfig, type PromptResult, type SessionRow, type RegistryQuery, type AuditEventRow, type SessionDirectory, type DirectoryEntry, type SettingsController, type AgentHomeConfig, type ApprovalHub, type Scheduler, type ScheduleInput, type Schedule } from "@newhorse/runtime"
import { redactSettings, aggregateUsage, type DagRunner, type DagStatus, createDagRunner } from "@newhorse/runtime"
import { currentGoal, tokensUsed as foldTokensUsed, currentTodos, validateGoal, projectCompacted } from "@newhorse/core"
import { discoverSkills, discoverPlugin } from "@newhorse/plugin"
import { SessionRegistry, SqliteEventStore, type DAGSpec } from "@newhorse/core"
import { Database } from "bun:sqlite"
import type { MemoryStore, MemoryRecord } from "@newhorse/memory"
import { listModels } from "@newhorse/llm"
import type { AdapterConfig, Fetcher } from "@newhorse/llm"
import type { StoredEvent, ApprovalRequest } from "@newhorse/schema"
import { join, resolve, sep } from "node:path"
import { readdir } from "node:fs/promises"

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
  /** Shared memory store — client memory browser reads/deletes via /v1/memory. */
  readonly memory?: MemoryStore
  /** Scheduled + on-demand DAG orchestration (编排). */
  readonly dagRunner?: DagRunner
  /** Plugin directory — skills/agents discovery for the capability browser. */
  readonly pluginsDir?: string
}

/** One session's create config (POST /v1/session body), transport DTO. */
export interface SessionCreateRequest {
  readonly workspace?: string
  readonly sessionId?: string
  readonly model?: string
  /** Create the session as the fixed BUTLER role (coordinator toolset + body). */
  readonly asButler?: boolean
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

/** Image attachment caps: per-image base64 (≈3MB raw, inside Anthropic's
 *  ~3.75MB base64/image guidance), per-prompt count, and the whole-body read
 *  bound. Worst case one request ≈ 5×4M base64 ≈ 20MB < the 32MB API ceiling. */
const MAX_IMAGE_BASE64 = 4_000_000
const MAX_IMAGES_PER_PROMPT = 5
const MAX_PROMPT_BODY = 40_000_000

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
  const rootAbs = resolve(root)
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1))
  const resolved = resolve(root, rel)
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + sep)) return json(403, { error: "forbidden" })
  const file = Bun.file(resolved)
  if (await file.exists()) {
    const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase()
    return new Response(file, { headers: CONTENT_TYPES[ext] ? { "content-type": CONTENT_TYPES[ext]! } : {} })
  }
  // SPA fallback: unknown extension-less paths load the app shell.
  if (!rel.includes(".")) {
    const index = Bun.file(join(rootAbs, "index.html"))
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
  const memory = config.memory
  const dagRunner = config.dagRunner
  const pluginsDir = config.pluginsDir
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
    if (settings) {
      // Lazy re-attach: the session exists in the DURABLE registry but no App
      // is attached yet (server restart). Rebuild it from the row so history
      // stays readable and the conversation can continue after a restart.
      try {
        const db = new Database(join(settings.get().dataDir, "events.db"), { readonly: true })
        let row: { sessionId: string; workspace: string; model?: string; role?: "butler" } | undefined
        try {
          const registry = new SessionRegistry(new SqliteEventStore(db))
          row = (await registry.list()).find((r) => r.sessionId === sessionId)
        } finally {
          db.close()
        }
        if (row) {
          // Re-attach keeps the fixed role: a butler session must come back
          // with its coordinator toolset after a restart, not as a plain chat.
          const resolved = await resolveApp({ sessionId, workspace: row.workspace, model: row.model, asButler: row.role === "butler" })
          if (resolved?.app) {
            if (directory) {
              directory.register(sessionId, selfUrl())
              owned.add(sessionId)
            }
            return { kind: "local", app: resolved.app }
          }
        }
      } catch {
        // registry unavailable — fall through to the resolver/miss
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
  async function promptStream(app: App, text: string, principal?: "user" | "butler" | "parent", signal?: AbortSignal, images?: { mime: string; data: string }[]): Promise<Response> {
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
      .prompt(text, principal, images)
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

      // POST /v1/session/:id/prompt — {text, principal?, images?: [{mime,data}]}.
      // Shape + caps are validated here so one bad paste can never poison the
      // append-only log or balloon a provider request. An image-only prompt
      // (empty text) is valid.
      if (method === "POST" && parts.length === 4 && parts[3] === "prompt") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        // Bound the buffered read BEFORE parsing: the caps below bound what is
        // LOGGED, not what a hostile body could make us buffer.
        const declared = Number(req.headers.get("content-length") ?? 0)
        if (declared > MAX_PROMPT_BODY) return json(413, { error: "request body too large" })
        const parsed = await readJsonOr400<{ text?: string; principal?: "user" | "butler" | "parent"; images?: { mime?: string; data?: string }[] }>(req)
        if ("error" in parsed) return json(400, parsed)
        const images: { mime: string; data: string }[] = []
        for (const img of parsed.images ?? []) {
          if (images.length >= MAX_IMAGES_PER_PROMPT) return json(400, { error: `too many images (max ${MAX_IMAGES_PER_PROMPT})` })
          if (!img.mime || !/^image\/(png|jpeg|webp|gif)$/.test(img.mime)) return json(400, { error: `unsupported image type: ${img.mime ?? "(none)"}` })
          if (!img.data || img.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data) || img.data.length % 4 !== 0) return json(400, { error: "invalid image payload (not base64 or over the size cap)" })
          images.push({ mime: img.mime, data: img.data })
        }
        if (!parsed.text && images.length === 0) return json(400, { error: "text or images required" })
        if (found.kind === "remote") return proxyPrompt(found.entry, parts[2]!, JSON.stringify({ text: parsed.text ?? "", principal: parsed.principal, ...(images.length ? { images } : {}) }), req.signal)
        return promptStream(found.app, parsed.text ?? "", parsed.principal, req.signal, images)
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

      // GET /v1/sessions — the DURABLE registry (survives restarts) when a
      // settings surface gives us the dataDir; otherwise the in-memory apps.
      if (method === "GET" && parts.length === 2 && parts[1] === "sessions") {
        const ws = url.searchParams.get("workspace") ?? undefined
        const st = url.searchParams.get("status") ?? undefined
        const query: RegistryQuery = ws || st ? { ...(ws ? { workspace: ws } : {}), ...(st ? { status: st as RegistryQuery["status"] } : {}) } : {}
        if (settings) {
          try {
            const db = new Database(join(settings.get().dataDir, "events.db"), { readonly: true })
            try {
              const store = new SqliteEventStore(db)
              const registry = new SessionRegistry(store)
              const rows = await registry.list(query)
              return json(200, rows)
            } finally {
              db.close()
            }
          } catch {
            // no events.db yet — fall through to the in-memory view
          }
        }
        const rows: SessionRow[] = []
        for (const app of apps.values()) rows.push(...(await app.listSessions(query)))
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

      // GET /v1/memory?q= — the client's memory browser.
      if (method === "GET" && parts.length === 2 && parts[1] === "memory") {
        if (!memory) return json(404, { error: "no memory store configured" })
        const q = url.searchParams.get("q") ?? ""
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)))
        const rows: MemoryRecord[] = await memory.search(q, limit)
        return json(200, { memories: rows })
      }

      // DELETE /v1/memory/:id — remove one memory.
      if (method === "DELETE" && parts.length === 3 && parts[1] === "memory") {
        if (!memory) return json(404, { error: "no memory store configured" })
        if (!memory.delete) return json(501, { error: "memory store does not support delete" })
        await memory.delete(parts[2]!)
        return json(200, { removed: true })
      }

      // --- 编排 (DAG) ---
      // POST /v1/dag {spec, workspace?, todoSessionId?} — declare + run (fire-and-forget).
      if (method === "POST" && parts.length === 2 && parts[1] === "dag") {
        if (!dagRunner) return json(404, { error: "no dag runner configured" })
        const parsed = await readJsonOr400<{ spec?: DAGSpec; workspace?: string; todoSessionId?: string }>(req)
        if ("error" in parsed) return json(400, parsed)
        if (!parsed.spec || typeof parsed.spec !== "object" || !parsed.spec.nodes || Object.keys(parsed.spec.nodes).length === 0) return json(400, { error: "spec.nodes is required (at least one node)" })
        try {
          const { dagId } = await dagRunner.run(parsed.spec, { workspace: parsed.workspace, todoSessionId: parsed.todoSessionId })
          return json(201, { dagId })
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) })
        }
      }

      // GET /v1/dags — all declared DAGs (durable fold).
      if (method === "GET" && parts.length === 2 && parts[1] === "dags") {
        if (!dagRunner) return json(404, { error: "no dag runner configured" })
        return json(200, { dags: await dagRunner.list() })
      }

      // GET /v1/dag/:id — node statuses for one DAG.
      if (method === "GET" && parts.length === 3 && parts[1] === "dag") {
        if (!dagRunner) return json(404, { error: "no dag runner configured" })
        const st = await dagRunner.status(parts[2]!)
        return st ? json(200, st) : json(404, { error: "unknown dag id" })
      }

      // GET /v1/session/:id/goal — folded goal + persisted usage.
      if (method === "GET" && parts.length === 4 && parts[3] === "goal") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        const events = (found.kind === "local" ? await found.app.events.read(parts[2]!) : await (await fetch(`${found.entry.endpoint}/v1/session/${parts[2]!}/events`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json()) as StoredEvent[]
        const goal = currentGoal(events)
        return json(200, { goal: goal ?? null, tokensUsed: foldTokensUsed(events) })
      }

      // POST /v1/session/:id/goal {objective, tokenBudget?} — durable goal write.
      if (method === "POST" && parts.length === 4 && parts[3] === "goal") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return json(501, { error: "goal write on a remote-owned session is not proxied yet" })
        const parsed = await readJsonOr400<{ objective?: string; tokenBudget?: number }>(req)
        if ("error" in parsed) return json(400, parsed)
        const valid = validateGoal(parsed.objective, "active", parsed.tokenBudget)
        if ("error" in valid) return json(400, { error: valid.error })
        await found.app.events.append(parts[2]!, "Session.GoalUpdated", { sessionId: parts[2]!, objective: valid.objective, status: "active", ...(valid.tokenBudget !== undefined ? { tokenBudget: valid.tokenBudget } : {}), ts: Date.now() })
        return json(201, { objective: valid.objective, tokenBudget: valid.tokenBudget ?? null })
      }

      // GET /v1/session/:id/todos — the current durable task list.
      if (method === "GET" && parts.length === 4 && parts[3] === "todos") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        const events = (found.kind === "local" ? await found.app.events.read(parts[2]!) : await (await fetch(`${found.entry.endpoint}/v1/session/${parts[2]!}/events`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json()) as StoredEvent[]
        return json(200, { todos: currentTodos(events) })
      }

      // GET /v1/session/:id/context — visible context size vs the window.
      if (method === "GET" && parts.length === 4 && parts[3] === "context") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        const events = (found.kind === "local" ? await found.app.events.read(parts[2]!) : await (await fetch(`${found.entry.endpoint}/v1/session/${parts[2]!}/events`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json()) as StoredEvent[]
        const { messages } = projectCompacted(events)
        const chars = messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
        const windowTokens = settings?.get().contextWindowTokens
        return json(200, { chars, estTokens: Math.ceil(chars / 2.5), ...(windowTokens ? { windowTokens, ratio: Math.min(1, Math.ceil(chars / 2.5) / (windowTokens * 0.6)) } : {}) })
      }

      // POST /v1/memory {content, type?, priority?} — client-side memory write.
      if (method === "POST" && parts.length === 2 && parts[1] === "memory") {
        if (!memory) return json(404, { error: "no memory store configured" })
        const parsed = await readJsonOr400<{ content?: string; type?: string; priority?: number }>(req)
        if ("error" in parsed) return json(400, parsed)
        if (!parsed.content?.trim()) return json(400, { error: "content is required" })
        const rec = await memory.write({ content: parsed.content.trim(), type: (parsed.type as "fact") ?? "fact", priority: parsed.priority ?? 50, sessionId: "client" })
        return json(201, rec)
      }

      // DELETE /v1/session/:id — hard delete (user-requested; archive is the
      // soft path). Owner-only: remote-owned sessions are not proxied. The
      // aggregate's whole event stream is removed from the store.
      if (method === "DELETE" && parts.length === 3 && parts[1] === "session") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return json(501, { error: "delete on a remote-owned session is not proxied yet" })
        found.app.interrupt()
        await found.app.events.delete(parts[2]!)
        apps.delete(parts[2]!)
        directory?.unregister(parts[2]!)
        owned.delete(parts[2]!)
        return json(200, { deleted: true })
      }

      // POST /v1/session/:id/archive {archived} — archive/unarchive a session.
      if (method === "POST" && parts.length === 4 && parts[3] === "archive") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return json(501, { error: "archive on a remote-owned session is not proxied yet" })
        const parsed = await readJsonOr400<{ archived?: boolean }>(req)
        if ("error" in parsed) return json(400, parsed)
        const archived = parsed.archived !== false
        await found.app.events.append(parts[2]!, "Session.Archived", { sessionId: parts[2]!, archived, ts: Date.now() })
        return json(200, { archived })
      }

      // POST /v1/session/:id/title {title} — durable rename (Session.TitleSet).
      if (method === "POST" && parts.length === 4 && parts[3] === "title") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return json(501, { error: "rename on a remote-owned session is not proxied yet" })
        const parsed = await readJsonOr400<{ title?: string }>(req)
        if ("error" in parsed) return json(400, parsed)
        const title = parsed.title?.trim()
        if (!title) return json(400, { error: "title is required" })
        await found.app.events.append(parts[2]!, "Session.TitleSet", { sessionId: parts[2]!, title, ts: Date.now() })
        return json(200, { title })
      }

      // POST /v1/session/:id/fork {atSeq?} — branch at a message boundary
      // (codex backtrack: append-only fork, never truncate). The child
      // re-Creates with the SOURCE's workspace (a fork is the same project —
      // `location: ""` would leave it working blind) and its fixed role.
      if (method === "POST" && parts.length === 4 && parts[3] === "fork") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return json(501, { error: "fork of a remote-owned session is not proxied yet" })
        const parsed = await readJsonOr400<{ atSeq?: number }>(req)
        if ("error" in parsed) return json(400, parsed)
        const source = await found.app.events.read(parts[2]!)
        const atSeq = parsed.atSeq !== undefined ? parsed.atSeq : Number.MAX_SAFE_INTEGER
        const created = source.find((e) => e.type === "Session.Created")
        const sourceData = (created?.data ?? {}) as { location?: string; role?: "butler" }
        const prefix = source.filter((e) => e.seq <= atSeq && e.type !== "Session.Created")
        if (prefix.length === 0) return json(400, { error: "nothing to fork at that seq" })
        const newId = crypto.randomUUID()
        for (const e of prefix) {
          await found.app.events.append(newId, e.type, e.data)
        }
        await found.app.events.append(newId, "Session.Created", {
          id: newId,
          location: sourceData.location ?? "",
          createdAt: Date.now(),
          ...(sourceData.role ? { role: sourceData.role } : {}),
        })
        return json(201, { sessionId: newId, forkedFrom: parts[2]!, atSeq: Math.min(atSeq, prefix[prefix.length - 1]!.seq) })
      }

      // GET/POST /v1/session/:id/policy — read or change this session's
      // permission level (strict | readonly | trusted). The change is durable
      // (Session.PolicyChanged) and effective from the next prompt.
      if (parts.length === 4 && parts[3] === "policy" && (method === "GET" || method === "POST")) {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return json(501, { error: "policy on a remote-owned session is not proxied yet" })
        if (method === "GET") return json(200, { policy: found.app.policy() })
        const parsed = await readJsonOr400<{ policy?: string }>(req)
        if ("error" in parsed) return json(400, parsed)
        const policy = parsed.policy
        if (policy !== "strict" && policy !== "readonly" && policy !== "trusted") return json(400, { error: "policy must be strict | readonly | trusted" })
        await found.app.setPolicy(policy)
        return json(200, { policy })
      }

      // GET /v1/fs?path=&workspace= — sandboxed one-level listing.
      if (method === "GET" && parts.length === 2 && parts[1] === "fs") {
        if (!settings) return json(404, { error: "no settings controller configured" })
        const ws = url.searchParams.get("workspace") ?? settings.get().workspace
        const rel = url.searchParams.get("path") ?? "."
        const rootAbs = resolve(ws)
        const targetAbs = resolve(ws, rel)
        if (targetAbs !== rootAbs && !targetAbs.startsWith(rootAbs + sep)) return json(403, { error: "path escapes the workspace" })
        try {
          const dir = await readdir(targetAbs, { withFileTypes: true })
          const entries = []
          for (const d of dir) {
            if (d.name.startsWith(".") || d.name === "node_modules") continue
            entries.push({ name: d.name, dir: d.isDirectory() })
          }
          return json(200, { path: rel, entries: entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1)) })
        } catch {
          return json(200, { path: rel, entries: [] })
        }
      }

      // GET /v1/skills — the pluginsDir skills catalog (level 1 + body on demand).
      if (method === "GET" && parts.length === 2 && parts[1] === "skills") {
        if (!pluginsDir) return json(404, { error: "no pluginsDir configured" })
        const name = url.searchParams.get("name")
        const skills = await discoverSkills(pluginsDir)
        if (name) {
          const hit = skills.find((sk) => sk.name === name)
          return hit ? json(200, hit) : json(404, { error: "unknown skill" })
        }
        return json(200, { skills: skills.map((sk) => ({ name: sk.name, description: sk.description, path: sk.path })) })
      }

      // GET /v1/agents — discovered agent roles (name/model/allowedTools).
      if (method === "GET" && parts.length === 2 && parts[1] === "agents") {
        if (!pluginsDir) return json(404, { error: "no pluginsDir configured" })
        const caps = await discoverPlugin(pluginsDir)
        return json(200, { agents: caps.filter((c) => c.kind === "agent") })
      }

      // GET /v1/commands — discovered slash commands (name/description only).
      if (method === "GET" && parts.length === 2 && parts[1] === "commands") {
        if (!pluginsDir) return json(404, { error: "no pluginsDir configured" })
        const caps = await discoverPlugin(pluginsDir)
        return json(200, { commands: caps.filter((c) => c.kind === "command").map((c) => ({ name: c.name, description: c.description })) })
      }

      // POST /v1/session/:id/command {text} — run a slash line ("/name args")
      // through the session's command seam. Returns the expansion text (the
      // client puts it back into the composer); 404 when not a command.
      if (method === "POST" && parts.length === 4 && parts[3] === "command") {
        const found = await findSession(parts[2]!)
        if (found.kind === "missing") return json(404, { error: found.error })
        if (found.kind === "remote") return json(501, { error: "commands on a remote-owned session are not proxied yet" })
        const parsed = await readJsonOr400<{ text?: string }>(req)
        if ("error" in parsed) return json(400, parsed)
        if (!parsed.text?.trim()) return json(400, { error: "text is required" })
        const output = await found.app.runCommand(parsed.text)
        if (output === undefined) return json(404, { error: `unknown command: ${parsed.text.trim().split(/\s+/)[0]}` })
        return json(200, { output })
      }

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
