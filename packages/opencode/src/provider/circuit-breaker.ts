import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { ProviderV2 } from "@newhorse/core/provider"
import { Config } from "@/config/config"

/**
 * Three-state circuit breaker per provider (cc-switch circuit_breaker.rs
 * port). In-memory only (provider health is transient; restarts reset state —
 * explicitly no durability).
 *
 * - Closed: requests flow; consecutive failures >= failureThreshold (or error
 *   rate >= errorRateThreshold once minRequests are seen) opens the circuit.
 * - Open: requests rejected immediately for timeoutSeconds; then HalfOpen.
 * - HalfOpen: one probe request is allowed; success (successThreshold times)
 *   closes, failure re-opens immediately.
 *
 * `isAvailable` is the routing-time check (no permit consumed);
 * `allowRequest` is called right before a request is issued.
 */

export interface CircuitBreakerConfig {
  failureThreshold: number
  successThreshold: number
  timeoutSeconds: number
  errorRateThreshold: number
  minRequests: number
}

export const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 4,
  successThreshold: 2,
  timeoutSeconds: 10,
  errorRateThreshold: 0.6,
  minRequests: 10,
}

export type CircuitState = "closed" | "open" | "half_open"

export interface BreakerState {
  state: CircuitState
  consecutiveFailures: number
  successCount: number
  requests: number
  failures: number
  openedAt?: number
}

export interface Interface {
  readonly isAvailable: (providerID: ProviderV2.ID) => Effect.Effect<boolean>
  readonly allowRequest: (providerID: ProviderV2.ID) => Effect.Effect<boolean>
  readonly recordSuccess: (providerID: ProviderV2.ID) => Effect.Effect<void>
  readonly recordFailure: (providerID: ProviderV2.ID) => Effect.Effect<void>
  readonly state: (providerID: ProviderV2.ID) => Effect.Effect<BreakerState>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/CircuitBreaker") {}

export function make(input?: Partial<CircuitBreakerConfig>): Interface {
  const config: CircuitBreakerConfig = { ...DEFAULT_CONFIG, ...input }
  const states = new Map<string, BreakerState>()

  const getState = (providerID: ProviderV2.ID): BreakerState => {
    let value = states.get(providerID)
    if (!value) {
      value = {
        state: "closed",
        consecutiveFailures: 0,
        successCount: 0,
        requests: 0,
        failures: 0,
      }
      states.set(providerID, value)
    }
    // Open -> HalfOpen when the timeout elapses. Checked lazily on read, so
    // no timer and no daemon (HANDOFF "no resident daemon").
    if (value.state === "open" && value.openedAt && Date.now() - value.openedAt >= config.timeoutSeconds * 1000) {
      value.state = "half_open"
      value.successCount = 0
    }
    return value
  }

  const open = (value: BreakerState) => {
    if (value.state === "open") return
    value.state = "open"
    value.openedAt = Date.now()
    value.successCount = 0
  }

  const isAvailable = Effect.fn("CircuitBreaker.isAvailable")(function* (providerID: ProviderV2.ID) {
    return getState(providerID).state !== "open"
  })

  const allowRequest = Effect.fn("CircuitBreaker.allowRequest")(function* (providerID: ProviderV2.ID) {
    const value = getState(providerID)
    if (value.state === "closed") return true
    if (value.state === "half_open") return true
    return false
  })

  const recordSuccess = Effect.fn("CircuitBreaker.recordSuccess")(function* (providerID: ProviderV2.ID) {
    const value = getState(providerID)
    value.requests += 1
    value.consecutiveFailures = 0
    if (value.state === "half_open") {
      value.successCount += 1
      if (value.successCount >= config.successThreshold) {
        value.state = "closed"
        value.successCount = 0
        value.failures = 0
      }
    }
  })

  const recordFailure = Effect.fn("CircuitBreaker.recordFailure")(function* (providerID: ProviderV2.ID) {
    const value = getState(providerID)
    value.requests += 1
    value.failures += 1
    value.consecutiveFailures += 1
    if (value.state === "half_open") {
      open(value)
      return
    }
    if (value.state !== "closed") return
    const errorRate = value.requests >= config.minRequests ? value.failures / value.requests : 0
    if (value.consecutiveFailures >= config.failureThreshold || errorRate >= config.errorRateThreshold) {
      open(value)
    }
  })

  const state = Effect.fn("CircuitBreaker.state")(function* (providerID: ProviderV2.ID) {
    return { ...getState(providerID) }
  })

  return { isAvailable, allowRequest, recordSuccess, recordFailure, state }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    // Circuit breaker thresholds are process-level, read from the GLOBAL
    // config (no InstanceRef required — this layer builds in background /
    // test fibers too). Missing/global-less environments fall back to defaults.
    const info = yield* cfg.getGlobal().pipe(Effect.catch(() => Effect.succeed(undefined)))
    const overrides = info?.experimental?.circuit_breaker
    const config: CircuitBreakerConfig = {
      failureThreshold: overrides?.failureThreshold ?? DEFAULT_CONFIG.failureThreshold,
      successThreshold: overrides?.successThreshold ?? DEFAULT_CONFIG.successThreshold,
      timeoutSeconds: overrides?.timeoutSeconds ?? DEFAULT_CONFIG.timeoutSeconds,
      errorRateThreshold: overrides?.errorRateThreshold ?? DEFAULT_CONFIG.errorRateThreshold,
      minRequests: overrides?.minRequests ?? DEFAULT_CONFIG.minRequests,
    }
    return make(config)
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node],
})

export * as CircuitBreaker from "./circuit-breaker"
