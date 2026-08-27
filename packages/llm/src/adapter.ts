import type { LLMRequest, LLMEvent } from "@newhorse/schema"
import type { Fetcher, LlmAdapter, Route, Protocol } from "./route"
import { streamRequest } from "./transport"
import { openaiProtocol } from "./protocol/openai"
import { anthropicProtocol } from "./protocol/anthropic"

export type ProviderKind = "openai" | "anthropic" | "openai-compatible"

export interface AdapterConfig {
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly apiKey?: string
  /** Extra auth headers a real deployment needs (e.g. `anthropic-version`). */
  readonly extraHeaders?: Readonly<Record<string, string>>
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

/** Build a Route for a provider kind (convenience for the common cases). */
function buildRoute(config: AdapterConfig): Route {
  const protocol = pickProtocol(config.kind)
  const path = config.kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions"
  const auth: Route["auth"] =
    config.kind === "anthropic"
      ? { header: "x-api-key", value: config.apiKey ?? "", extraHeaders: config.extraHeaders }
      : { header: "Authorization", value: `Bearer ${config.apiKey ?? ""}`, ...(config.extraHeaders ? { extraHeaders: config.extraHeaders } : {}) }
  return makeRoute({ protocol, baseUrl: config.baseUrl, path, auth })
}

function pickProtocol(kind: ProviderKind): Protocol {
  return kind === "anthropic" ? anthropicProtocol : openaiProtocol
}

/**
 * Create an LLM client bound to one provider. `fetch` is injectable so the
 * transport is testable without a live network.
 */
export function makeLlmClient(config: AdapterConfig, fetch: Fetcher = globalThis.fetch.bind(globalThis)): LlmClient {
  const route = buildRoute(config)
  return {
    id: `${config.kind}:${route.endpoint.baseUrl}`,
    async stream(request: LLMRequest): Promise<AsyncIterable<LLMEvent>> {
      const body = route.protocol.encode(request)
      return streamRequest(route, body, { fetch })
    },
  }
}

export type { LlmAdapter, Route }
