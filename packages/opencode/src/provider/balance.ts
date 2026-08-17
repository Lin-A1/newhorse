export * as Balance from "./balance"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Provider } from "./provider"
import { ProviderV2 } from "@newhorse/core/provider"
import { Auth } from "@/auth"

// Provider balance/credit checking — the "usage awareness" half of the
// cc-switch model, minus the sandbox: instead of running user-supplied JS, we
// ship a small set of *trusted built-in templates* (OpenRouter, DeepSeek) and
// fetch them directly. A template is just a fixed URL shape + a response
// extractor, so there is nothing to sandbox.
//
// Coverage is intentionally partial: only providers with a public balance
// endpoint are supported (OpenRouter /api/v1/credits, DeepSeek /user/balance).
// Anthropic, Google, Azure, Bedrock, etc. have no public billing API and are
// reported as "unsupported" rather than guessed.

export const BalanceInfo = Schema.Struct({
  providerID: Schema.String,
  /** Remaining balance in USD, if the provider reports it. */
  balance: Schema.optional(Schema.Number),
  /** Total credits (OpenRouter) or current balance (DeepSeek). */
  total: Schema.optional(Schema.Number),
  /** Billed usage so far (OpenRouter total_usage). */
  used: Schema.optional(Schema.Number),
  currency: Schema.optional(Schema.String),
  supported: Schema.Boolean,
  message: Schema.optional(Schema.String),
})
export type BalanceInfo = Schema.Schema.Type<typeof BalanceInfo>

type BalanceTemplate = {
  match: (providerID: string, baseURL: string | undefined) => boolean
  request: (baseURL: string, apiKey: string) => { url: string; headers: Record<string, string> }
  parse: (json: unknown) => {
    balance?: number
    total?: number
    used?: number
    currency?: string
  }
}

function withV1(baseURL: string, suffix: string): string {
  const normalized = baseURL.replace(/\/+$/, "")
  if (normalized.endsWith("/v1")) return `${normalized}/${suffix.replace(/^\//, "")}`
  return `${normalized}${suffix}`
}

const TEMPLATES: BalanceTemplate[] = [
  // OpenRouter: GET /api/v1/credits → { data: { total_credits, total_usage, currency } }
  {
    match: (providerID, baseURL) =>
      providerID.toLowerCase().includes("openrouter") || baseURL?.toLowerCase().includes("openrouter") === true,
    request: (baseURL, apiKey) => ({
      url: withV1(baseURL, "/api/v1/credits"),
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    }),
    parse: (json) => {
      const data = (json as { data?: { total_credits?: number; total_usage?: number; currency?: string } })?.data
      if (!data) return {}
      return {
        total: data.total_credits,
        used: data.total_usage,
        balance:
          data.total_credits !== undefined && data.total_usage !== undefined
            ? Math.max(0, data.total_credits - data.total_usage)
            : undefined,
        currency: data.currency,
      }
    },
  },
  // DeepSeek: GET https://api.deepseek.com/user/balance → { balance_infos: [{ total_balance, currency }] }
  {
    match: (providerID, baseURL) =>
      providerID.toLowerCase().includes("deepseek") || baseURL?.toLowerCase().includes("deepseek") === true,
    request: (baseURL, apiKey) => ({
      url: `${baseURL.replace(/\/+$/, "").replace(/\/v1$/, "")}/user/balance`,
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    }),
    parse: (json) => {
      const infos = (json as { balance_infos?: Array<{ total_balance?: number; currency?: string }> })?.balance_infos
      const first = infos?.[0]
      if (!first) return {}
      return { balance: first.total_balance, currency: first.currency }
    },
  },
]

function matchingTemplate(providerID: string, baseURL: string | undefined): BalanceTemplate | undefined {
  return TEMPLATES.find((template) => template.match(providerID, baseURL))
}

export interface Interface {
  readonly balance: (input: { providerID: string }) => Effect.Effect<BalanceInfo>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Balance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service

    const balance = Effect.fn("Balance.balance")(function* (input: { providerID: string }) {
      const providers = yield* provider.list()
      const info = providers[ProviderV2.ID.make(input.providerID)]
      if (!info) {
        return {
          providerID: input.providerID,
          supported: false,
          message: "provider not found",
        } satisfies BalanceInfo
      }

      const baseURL = typeof info.options?.baseURL === "string" ? info.options.baseURL : undefined
      const stored = yield* auth.get(input.providerID).pipe(Effect.orElseSucceed(() => undefined))
      const apiKey =
        (typeof info.key === "string" && info.key.length > 0 ? info.key : undefined) ??
        (stored?.type === "api" && typeof stored.key === "string" && stored.key.length > 0 ? stored.key : undefined)

      if (!baseURL || !apiKey) {
        return {
          providerID: input.providerID,
          supported: false,
          message: "missing baseURL or api key",
        } satisfies BalanceInfo
      }

      const template = matchingTemplate(input.providerID, baseURL)
      if (!template) {
        return {
          providerID: input.providerID,
          supported: false,
          message: "no public balance endpoint for this provider",
        } satisfies BalanceInfo
      }

      const { url, headers } = template.request(baseURL, apiKey)
      const json = yield* Effect.tryPromise({
        try: () =>
          fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json() as Promise<unknown>
          }),
        catch: (error) =>
          new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (json === undefined) {
        return {
          providerID: input.providerID,
          supported: false,
          message: "balance request failed",
        } satisfies BalanceInfo
      }

      const parsed = template.parse(json)
      if (parsed.balance === undefined && parsed.total === undefined) {
        return {
          providerID: input.providerID,
          supported: true,
          message: "balance endpoint returned no usable value",
        } satisfies BalanceInfo
      }
      return {
        providerID: input.providerID,
        supported: true,
        ...parsed,
      } satisfies BalanceInfo
    })

    return Service.of({ balance })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Provider.node, Auth.node] })
