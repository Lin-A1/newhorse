import { describe, expect, test } from "bun:test"
import { Projected } from "../../src/session/projected"
import { SessionV1 } from "@newhorse/core/v1/session"

const assistant = (input: Partial<SessionV1.Assistant> = {}): SessionV1.Assistant =>
  ({
    id: input.id ?? "msg-assistant",
    sessionID: "session",
    role: "assistant",
    time: { created: 1 },
    parentID: "msg-user",
    modelID: "test-model",
    providerID: "test",
    mode: "primary",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...input,
  }) as SessionV1.Assistant

const toolPart = (input: { status: "completed"; output: string }): SessionV1.Part =>
  ({
    type: "tool",
    id: "prt-tool",
    sessionID: "session",
    messageID: "msg-assistant",
    callID: "call-1",
    tool: "bash",
    state: {
      status: input.status,
      input: { command: "ls" },
      output: input.output,
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as unknown as SessionV1.Part

const withParts = (items: SessionV1.WithParts[]): SessionV1.WithParts[] => items

const cost = {
  input: 3,
  output: 15,
  cache: { read: 0.3, write: 5 },
}

describe("Projected.estimate", () => {
  test("empty surface returns zeros", () => {
    const result = Projected.estimateFrom([], { totalOutput: 0, contextWindow: 200_000, cost })
    expect(result.projectedTokens).toEqual({ nextInput: 0, nextOutput: 0, nextCost: 0, contextWindow: 200_000 })
    expect(result.contextBreakdown).toEqual({ system: 0, tools: 0, messages: 0 })
    expect(result.contextPressure).toEqual({ pressure: 0, projected: 0, window: 200_000 })
  })

  test("projects next request from a recent assistant turn", () => {
    const items = withParts([
      {
        info: assistant({
          tokens: { input: 5_000, output: 1_000, reasoning: 200, cache: { read: 10_000, write: 500 } },
        }),
        parts: [toolPart({ status: "completed", output: "done" })],
      },
    ])
    const result = Projected.estimateFrom(items, {
      totalOutput: 5_000,
      contextWindow: 200_000,
      outputLimit: 8_192,
      cost,
    })
    // context = 5000 + 10000 + 500; avg output from session total / 0 turns -> recent output (1200)
    const context = 15_500
    expect(result.projectedTokens.contextWindow).toBe(200_000)
    expect(result.projectedTokens.nextOutput).toBe(1200)
    // next input = context + growth(ceil(1200 * 1.35)) = 15500 + 1620
    expect(result.projectedTokens.nextInput).toBe(17_120)
    // breakdown sums to the context budget
    const breakdown = result.contextBreakdown
    expect(breakdown.system + breakdown.tools + breakdown.messages).toBe(context)
    expect(result.contextPressure.pressure).toBe(7.8)
  })

  test("clamps next input to the context window", () => {
    const result = Projected.estimate({
      context: 159_000,
      contextRead: 100_000,
      recentOutput: 1_000,
      totalOutput: 0,
      turns: 0,
      surfaceChars: { system: 0, tools: 0, messages: 0 },
      contextWindow: 160_000,
      outputLimit: 8_192,
      cost,
    })
    expect(result.projectedTokens.nextOutput).toBe(1000)
    expect(result.projectedTokens.nextInput).toBe(160_000)
    expect(result.contextPressure.projected).toBe(100)
  })

  test("projects the system prompt baseline for a fresh session", () => {
    const result = Projected.estimate({
      context: 0,
      contextRead: 0,
      recentOutput: 0,
      totalOutput: 0,
      turns: 0,
      surfaceChars: { system: 4_000, tools: 800, messages: 0 },
      contextWindow: 200_000,
      cost,
    })
    expect(result.projectedTokens.nextInput).toBe(1_000)
    expect(result.projectedTokens.nextOutput).toBe(0)
  })

  test("cost tier selection follows the projected context", () => {
    const tiered = {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 5 },
      tiers: [
        { input: 2, output: 10, cache: { read: 0.2, write: 4 }, tier: { type: "context" as const, size: 1_000 } },
      ],
    }
    const small = Projected.estimate({
      context: 500,
      contextRead: 0,
      recentOutput: 0,
      totalOutput: 0,
      turns: 0,
      surfaceChars: { system: 0, tools: 0, messages: 0 },
      contextWindow: 200_000,
      cost: tiered,
    })
    expect(small.projectedTokens.nextCost).toBeGreaterThan(0)
  })

  test("cache read discounts the next-input cost", () => {
    const cached = Projected.estimate({
      context: 10_000,
      contextRead: 8_000,
      recentOutput: 0,
      totalOutput: 0,
      turns: 0,
      surfaceChars: { system: 0, tools: 0, messages: 0 },
      contextWindow: 200_000,
      cost,
    })
    const fresh = Projected.estimate({
      context: 10_000,
      contextRead: 0,
      recentOutput: 0,
      totalOutput: 0,
      turns: 0,
      surfaceChars: { system: 0, tools: 0, messages: 0 },
      contextWindow: 200_000,
      cost,
    })
    expect(cached.projectedTokens.nextCost).toBeLessThan(fresh.projectedTokens.nextCost)
  })
})