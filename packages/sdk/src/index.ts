/**
 * @newhorse/sdk — the typed client for a newhorse runtime server.
 *
 * This is the REUSE entry point: an AI-native product embeds the runtime by
 * pointing this client at a server base URL — no domain logic crosses the
 * boundary (the server holds createApp; the SDK holds transport only).
 *
 * The surface mirrors the server contract 1:1 (see specs/v2/server.md):
 * create/attach a session, prompt (SSE stream), steer, interrupt, snapshot,
 * sessions list, audit, log events.
 */

/** One streamed loop event (mirrors the server's SSE payloads). */
export type SdkEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly input: unknown }
  | { readonly type: "tool-result"; readonly name: string; readonly output: unknown; readonly isError?: boolean }
  | { readonly type: "step"; readonly step: number }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "done"; readonly step: number; readonly needsContinuation: boolean; readonly finish: string }
  | { readonly type: "result"; readonly step: number; readonly needsContinuation: boolean; readonly finish: string }

export interface SdkSessionSnapshot {
  readonly id: string
  readonly location: string
  readonly messages: ReadonlyArray<{ kind: string; text?: string; content?: unknown }>
  readonly headSeq: number
}

export interface SdkSessionRow {
  readonly sessionId: string
  readonly workspace: string
  readonly status: string
  readonly model?: string
  readonly createdAt: number
}

export interface SdkCreateOptions {
  readonly sessionId?: string
  readonly workspace?: string
  readonly model?: string
  readonly dataDir?: string
}

export interface SdkClient {
  /** Create (or attach to) a session; returns its id. */
  readonly createSession: (opts?: SdkCreateOptions) => Promise<string>
  /** Prompt a session; calls onEvent per streamed event; resolves with the final result. */
  readonly prompt: (sessionId: string, text: string, onEvent?: (e: SdkEvent) => void, opts?: { principal?: "user" | "butler" | "parent"; signal?: AbortSignal }) => Promise<{ step: number; needsContinuation: boolean; finish: string }>
  /** Steer a live session (non-blocking admission). */
  readonly steer: (sessionId: string, text: string) => Promise<void>
  /** Interrupt a session's current run. */
  readonly interrupt: (sessionId: string) => Promise<void>
  /** Read a session snapshot. */
  readonly snapshot: (sessionId: string) => Promise<SdkSessionSnapshot>
  /** List sessions. */
  readonly sessions: (query?: { workspace?: string; status?: string }) => Promise<SdkSessionRow[]>
  /** Read the durable event log. */
  readonly events: (sessionId: string) => Promise<ReadonlyArray<{ type: string; data: unknown }>>
  /** Read the audit trail. */
  readonly audit: (actorSessionId?: string) => Promise<unknown[]>
  readonly close: () => Promise<void>
}

export interface SdkOptions {
  readonly baseUrl: string
  /** Bearer token (when the server requires one). */
  readonly token?: string
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch
}

export function createSdkClient(opts: SdkOptions): SdkClient {
  const base = opts.baseUrl.replace(/\/$/, "")
  const f = opts.fetch ?? globalThis.fetch
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
  })

  const json = async <T>(res: Response): Promise<T> => {
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new SdkError(res.status, body || res.statusText)
    }
    return res.json() as Promise<T>
  }

  return {
    async createSession(sessionOpts) {
      const res = await f(`${base}/v1/session`, { method: "POST", headers: headers(), body: JSON.stringify(sessionOpts ?? {}) })
      const body = await json<{ sessionId: string }>(res)
      return body.sessionId
    },

    async prompt(sessionId, text, onEvent, promptOpts) {
      const res = await f(`${base}/v1/session/${sessionId}/prompt`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ text, principal: promptOpts?.principal }),
        signal: promptOpts?.signal,
      })
      if (!res.ok || !res.body) throw new SdkError(res.status, await res.text().catch(() => res.statusText))
      // Consume the SSE stream: split frames on the blank line.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let final: { step: number; needsContinuation: boolean; finish: string } | undefined
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 2)
          if (!frame.startsWith("data:")) continue
          const payload = frame.slice(5).trim()
          if (payload === "[DONE]") continue
          try {
            const event = JSON.parse(payload) as SdkEvent
            if (event.type === "result") {
              final = { step: event.step, needsContinuation: event.needsContinuation, finish: event.finish }
            }
            onEvent?.(event)
          } catch {
            // skip malformed frames (the server never sends them today)
          }
        }
      }
      if (!final) throw new SdkError(0, "stream ended without a result")
      return final
    },

    async steer(sessionId, text) {
      const res = await f(`${base}/v1/session/${sessionId}/steer`, { method: "POST", headers: headers(), body: JSON.stringify({ text }) })
      await json(res)
    },

    async interrupt(sessionId) {
      const res = await f(`${base}/v1/session/${sessionId}/interrupt`, { method: "POST", headers: headers() })
      await json(res)
    },

    async snapshot(sessionId) {
      const res = await f(`${base}/v1/session/${sessionId}`, { headers: headers() })
      return json<SdkSessionSnapshot>(res)
    },

    async sessions(query) {
      const qs = new URLSearchParams()
      if (query?.workspace) qs.set("workspace", query.workspace)
      if (query?.status) qs.set("status", query.status)
      const qsText = qs.toString()
      const res = await f(`${base}/v1/sessions${qsText ? `?${qsText}` : ""}`, { headers: headers() })
      return json<SdkSessionRow[]>(res)
    },

    async events(sessionId) {
      const res = await f(`${base}/v1/session/${sessionId}/events`, { headers: headers() })
      return json<ReadonlyArray<{ type: string; data: unknown }>>(res)
    },

    async audit(actorSessionId) {
      const qs = actorSessionId ? `?actorSessionId=${encodeURIComponent(actorSessionId)}` : ""
      const res = await f(`${base}/v1/audit${qs}`, { headers: headers() })
      return json<unknown[]>(res)
    },

    async close() {
      // The SDK holds no live resources today (no persistent socket); kept for
      // API stability when a socket-based transport lands.
    },
  }
}

export class SdkError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`newhorse SDK error ${status}: ${message}`)
    this.name = "SdkError"
    this.status = status
  }
}
