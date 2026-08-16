import { Effect, Option } from "effect"
import { ProviderV2 } from "@newhorse/core/provider"
import { ModelV2 } from "@newhorse/core/model"
import { ConfigV1 } from "@newhorse/core/v1/config/config"
import { Provider } from "./provider"
import { CircuitBreaker } from "./circuit-breaker"

/**
 * One availability-aware fallback entry. Entries are tried in order; for each
 * entry, the first provider in `providers` that is connected and exposes
 * `model` is used.
 */
export interface FallbackChainEntry {
  providers: string[]
  model: string
  variant?: string
}

/** A resolved model reference: provider + model, optionally with a variant. */
export interface ModelRef {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: string
}

/** Where the resolved model came from. */
export type ModelSource = "override" | "fallback" | "default"

export interface ResolvedModel extends ModelRef {
  source: ModelSource
}

export interface ResolveWithFallbackInput {
  /**
   * Explicit session/agent model override. Bypasses availability checks so
   * `session.model` / `agent.model` keep their current behavior.
   */
  explicit?: ModelRef
  /** Availability-aware fallback chain from the agent config. */
  fallbackChain?: readonly FallbackChainEntry[]
  /** Terminal catalog default used when the chain is empty or fully unavailable. */
  defaultModel: Effect.Effect<ModelRef>
}

/**
 * Availability-aware model resolution:
 *
 *   1. explicit override (`session.model` / `agent.model`) — no availability check
 *   2. `fallbackChain` entries, in order, first connected provider exposing the model wins
 *   3. the caller's catalog default
 *
 * Availability is derived from `Provider.list()`: a provider is available when
 * it is present in the list (i.e. connected) and exposes the requested model.
 */
export function resolveWithFallback(
  provider: Provider.Interface,
  input: ResolveWithFallbackInput,
): Effect.Effect<ResolvedModel> {
  return Effect.gen(function* () {
    if (input.explicit) {
      return {
        providerID: input.explicit.providerID,
        modelID: input.explicit.modelID,
        variant: input.explicit.variant,
        source: "override" as const,
      }
    }

    if (input.fallbackChain && input.fallbackChain.length > 0) {
      const breaker = yield* Effect.serviceOption(CircuitBreaker.Service)
      const providers = yield* provider.list().pipe(Effect.orDie)
      for (const entry of input.fallbackChain) {
        for (const providerID of entry.providers) {
          const id = ProviderV2.ID.make(providerID)
          const info = providers[id]
          if (!info) continue
          if (!info.models[entry.model]) continue
          // Circuit breaker: skip providers whose circuit is open so a broken
          // provider is not re-selected (and does not make every request wait
          // for its timeout) once it has failed enough.
          if (Option.isSome(breaker) && !(yield* breaker.value.isAvailable(id))) {
            yield* Effect.logWarning("fallback provider circuit open; skipping", {
              providerID: id,
              model: entry.model,
            })
            continue
          }
          return {
            providerID: id,
            modelID: ModelV2.ID.make(entry.model),
            variant: entry.variant,
            source: "fallback" as const,
          }
        }
      }
    }

    const def = yield* input.defaultModel
    return {
      providerID: def.providerID,
      modelID: def.modelID,
      variant: def.variant,
      source: "default" as const,
    }
  })
}

/**
 * Reads an agent's `fallbackChain` from the loaded v1 config. Agent config is
 * keyed by the agent name, mirroring how the agent registry looks it up.
 */
export function fallbackChainForAgent(
  config: ConfigV1.Info,
  agentName: string,
): readonly FallbackChainEntry[] | undefined {
  return config.agent?.[agentName]?.fallbackChain
}
