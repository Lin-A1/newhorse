import type { LLMRequest, LLMEvent } from "@newhorse/schema"

/**
 * Four-axis Route: decouples what we ask a model from how the deployment
 * serves it. The agent loop speaks only `LLMRequest`/`LLMEvent`; provider
 * quirks live inside a Protocol, never in the loop.
 *
 *   Protocol  — semantic contract per provider family (how to encode a request
 *               and decode a stream). This is what lets openai-compatible,
 *               anthropic, deepseek, together, etc. share one protocol.
 *   Endpoint  — where to send it (baseURL / path).
 *   Auth      — how to authenticate (bearer / header / key).
 *   Framing   — how bytes are framed on the wire (sse / json / binary).
 */

export interface Route {
  readonly protocol: Protocol
  readonly endpoint: Endpoint
  readonly auth: Auth
  readonly framing: Framing
}

/** Protocol: encode a canonical request into a provider body + transport, and
 * decode a provider stream back into canonical LLMEvents. */
export interface Protocol {
  readonly id: string
  /** Map a canonical LLMRequest to the provider wire body for this protocol. */
  readonly encode: (request: LLMRequest) => Body
  /** Build the initial state for decoding a provider stream. */
  readonly init: () => unknown
  /** Consume one provider message, emit zero or more canonical events. */
  readonly step: (state: unknown, message: unknown) => { readonly state: unknown; readonly events: LLMEvent[] }
}

export interface Endpoint {
  readonly baseUrl: string
  readonly path: string
  resolve(): string
}

export interface Auth {
  readonly header: string
  readonly value: string
  /** Additional headers a real deployment needs (e.g. `anthropic-version`). */
  readonly extraHeaders?: Readonly<Record<string, string>>
}

export interface Framing {
  readonly kind: "sse" | "json"
}

export type Body = Record<string, unknown>

/**
 * A provider that can lower a canonical request into an endpoint call and
 * unwrap its stream into canonical events. This is the "provider" half of the
 * llm seam and is the only thing an adapter implements beyond the Route.
 */
export interface LlmAdapter {
  readonly id: string
  readonly route: Route
}

/**
 * Minimal fetch contract. Global `fetch` satisfies it; tests inject a stub so
 * the HTTP transport stays fully testable without a live network.
 */
export interface Fetcher {
  (input: string, init?: RequestInit): Promise<Response>
}

/** A streamed response the transport surfaces to the caller. */
export interface StreamHandle {
  readonly events: AsyncIterable<LLMEvent>
}
