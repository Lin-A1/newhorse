import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderV2 } from "@newhorse/core/provider"
import { make } from "../../src/provider/circuit-breaker"

const pid = ProviderV2.ID.make("test-provider")

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("circuit breaker", () => {
  test("starts closed and allows requests", async () => {
    const breaker = make()
    expect(await run(breaker.isAvailable(pid))).toBe(true)
    expect(await run(breaker.allowRequest(pid))).toBe(true)
    expect((await run(breaker.state(pid))).state).toBe("closed")
  })

  test("opens after the consecutive-failure threshold", async () => {
    const breaker = make({ failureThreshold: 3, timeoutSeconds: 60 })
    await run(breaker.recordFailure(pid))
    await run(breaker.recordFailure(pid))
    expect(await run(breaker.isAvailable(pid))).toBe(true)
    await run(breaker.recordFailure(pid))
    expect((await run(breaker.state(pid))).state).toBe("open")
    expect(await run(breaker.isAvailable(pid))).toBe(false)
    expect(await run(breaker.allowRequest(pid))).toBe(false)
  })

  test("opens on the error-rate threshold once minRequests are seen", async () => {
    const breaker = make({ failureThreshold: 100, errorRateThreshold: 0.6, minRequests: 10, timeoutSeconds: 60 })
    for (let i = 0; i < 4; i++) await run(breaker.recordSuccess(pid))
    for (let i = 0; i < 6; i++) await run(breaker.recordFailure(pid))
    const state = await run(breaker.state(pid))
    expect(state.requests).toBe(10)
    expect(state.state).toBe("open")
  })

  test("half-open probe failure re-opens the circuit immediately", async () => {
    const breaker = make({ failureThreshold: 1, successThreshold: 2, timeoutSeconds: 0.05 })
    await run(breaker.recordFailure(pid))
    expect((await run(breaker.state(pid))).state).toBe("open")
    await Bun.sleep(60)
    // Timeout elapses -> half-open on the next read.
    expect(await run(breaker.allowRequest(pid))).toBe(true)
    await run(breaker.recordFailure(pid))
    expect((await run(breaker.state(pid))).state).toBe("open")
  })

  test("half-open successes close the circuit after the success threshold", async () => {
    const breaker = make({ failureThreshold: 1, successThreshold: 2, timeoutSeconds: 0.05 })
    await run(breaker.recordFailure(pid))
    await Bun.sleep(60)
    expect(await run(breaker.allowRequest(pid))).toBe(true)
    await run(breaker.recordSuccess(pid))
    expect((await run(breaker.state(pid))).state).toBe("half_open")
    await run(breaker.recordSuccess(pid))
    expect((await run(breaker.state(pid))).state).toBe("closed")
    expect(await run(breaker.isAvailable(pid))).toBe(true)
  })

  test("providers are isolated per providerID", async () => {
    const breaker = make({ failureThreshold: 1, timeoutSeconds: 60 })
    const other = ProviderV2.ID.make("other-provider")
    await run(breaker.recordFailure(pid))
    expect(await run(breaker.isAvailable(pid))).toBe(false)
    expect(await run(breaker.isAvailable(other))).toBe(true)
  })

  test("success resets the consecutive failure counter", async () => {
    const breaker = make({ failureThreshold: 3, timeoutSeconds: 60 })
    await run(breaker.recordFailure(pid))
    await run(breaker.recordFailure(pid))
    await run(breaker.recordSuccess(pid))
    await run(breaker.recordFailure(pid))
    await run(breaker.recordFailure(pid))
    expect((await run(breaker.state(pid))).state).toBe("closed")
  })
})
