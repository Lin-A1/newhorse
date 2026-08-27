import type { LLMEvent } from "@newhorse/schema"
import type { Fetcher, Route } from "./route"

export interface StreamOptions {
  readonly fetch: Fetcher
}

/**
 * Send a request through a Route and surface its canonical events.
 *
 * The transport is the only place that touches the wire. It uses the Route's
 * protocol to decode each provider message into canonical LLMEvents, so the
 * caller (the agent loop) never sees provider quirks.
 */
export async function streamRequest(route: Route, body: unknown, options: StreamOptions): Promise<AsyncIterable<LLMEvent>> {
  const response = await options.fetch(route.endpoint.resolve(), {
    method: "POST",
    headers: buildHeaders(route),
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const message = await safeText(response)
    throw classifyHttpError(response.status, message)
  }

  if (route.framing.kind === "sse") {
    return sseEvents(route, response)
  }

  return jsonEvents(route, response)
}

function buildHeaders(route: Route): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: route.framing.kind === "sse" ? "text/event-stream" : "application/json",
    [route.auth.header]: route.auth.value,
    ...(route.auth.extraHeaders ?? {}),
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return "(no body)"
  }
}

async function* sseEvents(route: Route, response: Response): AsyncIterable<LLMEvent> {
  const reader = response.body?.getReader()
  if (!reader) return

  let state = route.protocol.init()
  let buffer = ""
  const decoder = new TextDecoder()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let index: number
    while ((index = findLineEnd(buffer)) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") return
      const message = parseJsonOrSkip(payload)
      if (message === undefined) continue
      const next = route.protocol.step(state, message)
      state = next.state
      for (const event of next.events) yield event
    }
  }
}

async function* jsonEvents(route: Route, response: Response): AsyncIterable<LLMEvent> {
  const text = await response.text()
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  let state = route.protocol.init()
  for (const line of lines) {
    const message = parseJsonOrSkip(line)
    if (message === undefined) continue
    const next = route.protocol.step(state, message)
    state = next.state
    for (const event of next.events) yield event
  }
}

function findLineEnd(buffer: string): number {
  const nl = buffer.indexOf("\n")
  const cr = buffer.indexOf("\r\n")
  if (nl === -1) return cr
  if (cr === -1) return nl
  return Math.min(nl, cr)
}

function parseJsonOrSkip(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export class LlmHttpError extends Error {
  readonly _tag = "LlmHttpError"
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  constructor(status: number, message: string, code: string, retryable: boolean) {
    super(`LLM HTTP ${status} (${code}): ${message}`)
    this.name = "LlmHttpError"
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Uniform HTTP error taxonomy: map status to a semantic code + retryable flag.
 * 429/5xx are retryable; 400 context-overflow and 404/401/403/413/422 are not.
 * This is the "uniform error taxonomy + retry" surface the agent loop relies on.
 */
export function classifyHttpError(status: number, message: string): LlmHttpError {
  const code = codeForStatus(status, message)
  const retryable = status === 429 || status >= 500
  return new LlmHttpError(status, message, code, retryable)
}

function codeForStatus(status: number, message: string): string {
  if (status === 400 && /context|length|token/i.test(message)) return "context-overflow"
  if (status === 429) return "rate-limited"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not-found"
  if (status === 413) return "too-large"
  if (status === 422) return "invalid-request"
  return status >= 500 ? "server" : "unknown"
}
