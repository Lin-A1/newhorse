import type { LLMRequest, LLMEvent } from "@newhorse/schema"
import type { Fetcher, LlmAdapter, Route, Protocol } from "./route"
import { streamRequest, streamWithRetry } from "./transport"
import { openaiProtocol } from "./protocol/openai"
import { openaiResponsesProtocol } from "./protocol/openai-responses"
import { anthropicProtocol } from "./protocol/anthropic"

export type ProviderKind = "openai" | "openai-responses" | "anthropic" | "openai-compatible"

export interface AdapterConfig {
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly apiKey?: string
  /** Extra auth headers a real deployment needs (e.g. `anthropic-version`). */
  readonly extraHeaders?: Readonly<Record<string, string>>
  /** Max retry attempts for retryable HTTP errors (429/5xx). Default 3. */
  readonly maxRetries?: number
}

export interface LlmClient {
  readonly id: string
  readonly stream: (request: LLMRequest) => Promise<AsyncIterable<LLMEvent>>
}

/**
 * Build a Route from four independently-specified axes. This is the public way
 * to reassemble axes (e.g. reuse openaiProtocol with a Bedrock-style endpoint
 * + signature auth). `makeLlmClient` is just a convenience factory over kind.
 */
export function makeRoute(parts: { readonly protocol: Protocol; readonly baseUrl: string; readonly path: string; readonly auth: Route["auth"]; readonly framing?: Route["framing"] }): Route {
  return {
    protocol: parts.protocol,
    endpoint: {
      baseUrl: parts.baseUrl,
      path: parts.path,
      resolve() {
        return this.baseUrl.replace(/\/$/, "") + this.path
      },
    },
    auth: parts.auth,
    framing: parts.framing ?? { kind: "sse" },
  }
}

/** Provider wiring as a lookup table, not scattered if/switch chains. */
const PROVIDERS: Record<ProviderKind, { readonly protocol: Protocol; readonly path: string; readonly authHeader: string }> = {
  openai: { protocol: openaiProtocol, path: "/v1/chat/completions", authHeader: "Authorization" },
  "openai-responses": { protocol: openaiResponsesProtocol, path: "/v1/responses", authHeader: "Authorization" },
  anthropic: { protocol: anthropicProtocol, path: "/v1/messages", authHeader: "x-api-key" },
  "openai-compatible": { protocol: openaiProtocol, path: "/v1/chat/completions", authHeader: "Authorization" },
}

/** Build a Route for a provider kind (convenience for the common cases). */
function buildRoute(config: AdapterConfig): Route {
  const p = PROVIDERS[config.kind]
  const auth: Route["auth"] =
    p.authHeader === "x-api-key"
      ? { header: "x-api-key", value: config.apiKey ?? "", extraHeaders: config.extraHeaders }
      : { header: "Authorization", value: `Bearer ${config.apiKey ?? ""}`, ...(config.extraHeaders ? { extraHeaders: config.extraHeaders } : {}) }
  return makeRoute({ protocol: p.protocol, baseUrl: config.baseUrl, path: p.path, auth })
}

/**
 * Create an LLM client bound to one provider. `fetch` is injectable so the
 * transport is testable without a live network.
 */
export function makeLlmClient(config: AdapterConfig, fetch: Fetcher = globalThis.fetch.bind(globalThis)): LlmClient {
  const route = buildRoute(config)
  const maxRetries = config.maxRetries ?? 3
  return {
    id: `${config.kind}:${route.endpoint.baseUrl}`,
    async stream(request: LLMRequest): Promise<AsyncIterable<LLMEvent>> {
      const body = route.protocol.encode(request)
      return streamWithRetry(() => streamRequest(route, body, { fetch }), maxRetries)
    },
  }
}

export type { LlmAdapter, Route }
