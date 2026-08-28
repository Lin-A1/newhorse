import type { LLMEvent } from "@newhorse/schema"
import type { Fetcher, Route } from "./route"

export interface StreamOptions {
  readonly fetch: Fetcher
  /** Optional abort signal so a blocked stream read can be cancelled. */
  readonly signal?: AbortSignal
}

/** Thrown when a streamed request is cancelled via its AbortSignal. */
export class LlmCancelled extends Error {
  readonly _tag = "LlmCancelled"
  constructor() {
    super("LLM stream cancelled")
    this.name = "LlmCancelled"
  }
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
    signal: options.signal,
  })

  if (!response.ok) {
    const message = await safeText(response)
    throw classifyHttpError(response.status, message)
  }

  if (route.framing.kind === "sse") {
    return sseEvents(route, response, options.signal)
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

async function* sseEvents(route: Route, response: Response, signal?: AbortSignal): AsyncIterable<LLMEvent> {
  const reader = response.body?.getReader()
  if (!reader) return

  let state = route.protocol.init()
  let buffer = ""
  const decoder = new TextDecoder()

  while (true) {
    if (signal?.aborted) throw new LlmCancelled()
    const { done, value } = await readWithAbort(reader, signal)
    if (signal?.aborted) throw new LlmCancelled()
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

/** Wait for either a read chunk or an abort signal, whichever comes first. */
async function readWithAbort(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> },
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!signal) return reader.read()
  if (signal.aborted) return { done: true, value: undefined }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reader.cancel().catch(() => {})
      resolve({ done: true, value: undefined })
    }
    signal.addEventListener("abort", onAbort, { once: true })
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort)
        resolve(result)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
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

export function codeForStatus(status: number, message: string): string {
  if (status === 400 && /context|length|token/i.test(message)) return "context-overflow"
  if (status === 429) return "rate-limited"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not-found"
  if (status === 413) return "too-large"
  if (status === 422) return "invalid-request"
  return status >= 500 ? "server" : "unknown"
}

/** Default base delay (ms) before a retry; doubled each attempt. */
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 8000

/**
 * Retry a streamed request on retryable errors (429 rate-limit, 5xx server),
 * with exponential backoff + jitter, up to `maxRetries` attempts. Non-retryable
 * errors (401/403/404/413/422/400 context-overflow) throw immediately. Returns
 * the first successful stream, or throws the last retryable error after the
 * budget is exhausted.
 */
export async function streamWithRetry(
  attempt: () => Promise<AsyncIterable<LLMEvent>>,
  maxRetries = 3,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<AsyncIterable<LLMEvent>> {
  let lastError: LlmHttpError | undefined
  for (let attemptNo = 0; attemptNo <= maxRetries; attemptNo++) {
    try {
      return await attempt()
    } catch (e) {
      if (!(e instanceof LlmHttpError) || !e.retryable) throw e
      lastError = e
      if (attemptNo >= maxRetries) break
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attemptNo) + jitter()
      await sleep(delay)
    }
  }
  throw lastError
}

function jitter(): number {
  return Math.floor(Math.random() * 250)
}
