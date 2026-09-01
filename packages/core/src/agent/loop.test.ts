import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "../session/store"
import { MemorySessionInput } from "../session/input"
import { Session, asSessionMessage } from "../session/session"
import { runSession, compactLimit, type ModelCallInfo } from "./loop"
import type { TurnRuntime, Agent, Tool } from "./runner"
import type { LLMEvent, LLMRequest } from "@newhorse/schema"

function makeRuntime(llm: TurnRuntime["llm"], tools: Tool[] = []): { runtime: TurnRuntime; resolveTool: (n: string) => Tool | undefined } {
  const events = new MemoryEventStore()
  const inbox = new MemorySessionInput(events)
  const map = new Map(tools.map((t) => [t.name, t]))
  return {
    runtime: { events, inbox, llm },
    resolveTool: (n) => map.get(n),
  }
}

const agent: Agent = { id: "build", model: "test-model" }

describe("turn loop", () => {
  it("archives assistant text and runs one stop turn", async () => {
    const llm: TurnRuntime["llm"] = { id: "t", stream: async () => eventsOf([{ type: "text.delta", text: "hello" }, { type: "step-finish", finish: "stop" }]) }
    const { runtime, resolveTool } = makeRuntime(llm)
    await runtime.events.append("s1", "Session.Created", { id: "s1", location: "/proj", createdAt: 1 })
    await runtime.inbox.admit({ id: "m1", sessionId: "s1", prompt: "hi", delivery: "steer" })

    const result = await runSession(runtime, { agent, sessionId: "s1", resolveTool })
    expect(result.needsContinuation).toBe(false)

    const session = Session.replay(await runtime.events.read("s1"))
    const assistant = session.messages.find((m) => m.kind === "assistant")
    expect(assistant && asSessionMessage(assistant)?.kind).toBe("assistant")
    expect(session.messages.some((m) => m.kind === "tool")).toBe(false)
  })

  it("executes a tool, archives its result, and continues", async () => {
    const llm: TurnRuntime["llm"] = {
      id: "t",
      stream: async () =>
        eventsOf([
          { type: "tool-call", id: "call_1", name: "search", input: { q: "a" } },
          { type: "step-finish", finish: "tool" },
        ]),
    }
    const search: Tool = { name: "search", execute: async () => ({ n: 2 }) }
    const { runtime, resolveTool } = makeRuntime(llm, [search])
    await runtime.events.append("s1", "Session.Created", { id: "s1", location: "/proj", createdAt: 1 })
    await runtime.inbox.admit({ id: "m1", sessionId: "s1", prompt: "find", delivery: "steer" })

    await runSession(runtime, { agent, sessionId: "s1", resolveTool })

    const session = Session.replay(await runtime.events.read("s1"))
    const tool = session.messages.find((m) => m.kind === "tool")
    // tool message stores callId so encoders can bind to the tool-call
    expect(tool && asSessionMessage(tool)?.kind).toBe("tool")
    expect((tool as { callId?: string } | undefined)?.callId).toBe("call_1")
  })

  it("drains multiple steers handled in the same session", async () => {
    let calls = 0
    const llm: TurnRuntime["llm"] = {
      id: "t",
      stream: async () => {
        calls += 1
        return eventsOf([{ type: "text.delta", text: `turn${calls}` }, { type: "step-finish", finish: calls > 1 ? "stop" : "tool" }])
      },
    }
    const { runtime, resolveTool } = makeRuntime(llm)
    await runtime.events.append("s1", "Session.Created", { id: "s1", location: "/proj", createdAt: 1 })
    const inbox = runtime.inbox as MemorySessionInput
    await inbox.admit({ id: "m1", sessionId: "s1", prompt: "a", delivery: "steer" })
    await inbox.admit({ id: "m2", sessionId: "s1", prompt: "b", delivery: "queue" })

    await runSession(runtime, { agent, sessionId: "s1", resolveTool })
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  it("records the interruption boundary once across cancel-then-resume", async () => {
    // Run 1: the stream emits a tool-call then aborts (cancellation). The partial
    // assistant that carries the unresolved tool-call is flushed, and one
    // Session.Interrupted is recorded. Run 2 resumes; the failInterruptedTools
    // repair finds that same unresolved tool-call and would append its own
    // Session.Interrupted — it must NOT, so the boundary stays single.
    let call = 0
    const llm: TurnRuntime["llm"] = {
      id: "t",
      stream: async () => {
        call += 1
        if (call === 1) {
          const abortErr = new Error("aborted")
          abortErr.name = "AbortError"
          return eventsThrowAfter([{ type: "tool-call", id: "call_1", name: "search", input: { q: "a" } }], abortErr)
        }
        return eventsOf([{ type: "text.delta", text: "done" }, { type: "step-finish", finish: "stop" }])
      },
    }
    const { runtime, resolveTool } = makeRuntime(llm, [])
    await runtime.events.append("s1", "Session.Created", { id: "s1", location: "/proj", createdAt: 1 })
    await runtime.inbox.admit({ id: "m1", sessionId: "s1", prompt: "hi", delivery: "steer" })

    // First run: tool-call buffered then stream aborts -> cancelledResult.
    await runSession(runtime, { agent, sessionId: "s1", resolveTool })
    const afterCancel = await runtime.events.read("s1")
    const interrupted1 = afterCancel.filter((e) => e.type === "Session.Interrupted").length
    expect(interrupted1).toBe(1)

    // Second run: resume. The repair path runs against the flushed partial
    // assistant that still carries call_1's unresolved tool-call.
    await runSession(runtime, { agent, sessionId: "s1", resolveTool })
    const events = await runtime.events.read("s1")
    const interrupted = events.filter((e) => e.type === "Session.Interrupted").length
    expect(interrupted).toBe(1)
  })
})

function eventsOf(events: LLMEvent[]): AsyncIterable<LLMEvent> {
  return (async function* () {
    for (const e of events) yield e
  })()
}

/** A stream that yields `events` then throws `err` — simulates a mid-stream abort. */
function eventsThrowAfter(events: LLMEvent[], err: Error): AsyncIterable<LLMEvent> {
  return (async function* () {
    for (const e of events) yield e
    throw err
  })()
}

it("auto-compaction bounds the request once (no repeated re-pack) for a long history", async () => {
  let request: LLMRequest | undefined
  const { runtime, resolveTool } = makeRuntime({
    id: "t",
    stream: async (req) => {
      request = req
      return eventsOf([{ type: "text.delta", text: "final" }, { type: "step-finish", finish: "stop" }])
    },
  })
  await runtime.events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  // Seed a long history (> 80k chars by a wide margin) so the trigger fires.
  const big = "x".repeat(2000)
  for (let i = 0; i < 60; i++) {
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "user", id: `u${i}`, seq: i * 2, text: big } })
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "assistant", id: `a${i}`, seq: i * 2 + 1, content: [{ type: "text", text: big }], model: "m" } })
  }
  await runtime.events.append("s", "Session.Prompted", { id: "p", sessionId: "s", prompt: "go", delivery: "steer", principal: "user", promotedSeq: 999 })
  const result = await runSession(runtime, { sessionId: "s", agent, resolveTool, compactThreshold: 80_000 })
  expect(result.finish).toBe("stop")
  // The request is bounded: far fewer chars than the 60·2000·2 seed.
  const seenChars = request ? request.messages.map((m) => JSON.stringify(m.content)).join("").length : 0
  const seededChars = 60 * 2000 * 2
  expect(seenChars).toBeLessThan(seededChars / 2)
  // A boundary was written exactly once.
  const boundaryCount = (await runtime.events.read("s")).filter((e) => e.type === "Session.Compacted").length
  expect(boundaryCount).toBe(1)
})

it("auto-compaction re-fires on a later turn after the first boundary (long-horizon escape)", async () => {
  let request: LLMRequest | undefined
  const { runtime, resolveTool } = makeRuntime({
    id: "t",
    stream: async (req) => {
      request = req
      return eventsOf([{ type: "text.delta", text: "ok" }, { type: "step-finish", finish: "stop" }])
    },
  })
  await runtime.events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  const big = "x".repeat(2000)
  for (let i = 0; i < 60; i++) {
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "user", id: `u${i}`, seq: i * 2, text: big } })
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "assistant", id: `a${i}`, seq: i * 2 + 1, content: [{ type: "text", text: big }], model: "m" } })
  }
  await runtime.events.append("s", "Session.Prompted", { id: "p", sessionId: "s", prompt: "go", delivery: "steer", principal: "user", promotedSeq: 999 })
  await runSession(runtime, { sessionId: "s", agent, resolveTool, compactThreshold: 80_000 })

  // Hard part: after the first compaction, append enough NEW content that the
  // PROJECTED tail (kept by the boundary) again exceeds the budget, then run
  // a second drain — the trigger must fire AGAIN (deeper boundary), not stall.
  const after = await runtime.events.read("s")
  const lastSeq = after.at(-1)!.seq
  for (let i = 0; i < 60; i++) {
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "user", id: `u2-${i}`, seq: lastSeq + 1 + i * 2, text: big } })
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "assistant", id: `a2-${i}`, seq: lastSeq + 2 + i * 2, content: [{ type: "text", text: big }], model: "m" } })
  }
  await runtime.events.append("s", "Session.Prompted", { id: "p2", sessionId: "s", prompt: "continue", delivery: "steer", principal: "user", promotedSeq: lastSeq + 130 })
  await runSession(runtime, { sessionId: "s", agent, resolveTool, compactThreshold: 80_000 })

  const boundaries = (await runtime.events.read("s")).filter((e) => e.type === "Session.Compacted").map((e) => (e.data as { boundarySeq?: number }).boundarySeq)
  expect(boundaries.length).toBe(2)
  expect(boundaries[1]!).toBeGreaterThan(boundaries[0]!) // a second, deeper fold
})

it("goal budget enforcement pauses an over-budget run (finish=length, goal blocked)", async () => {
  const { runtime, resolveTool } = makeRuntime({
    id: "t",
    stream: async () => eventsOf([{ type: "text.delta", text: "should never reach the LLM" }, { type: "step-finish", finish: "stop" }]),
  })
  await runtime.events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  // Budget 100; the seeded usage is 500 (over).
  await runtime.events.append("s", "Session.StepEnded", { sessionId: "s", step: 1, finish: "stop", usage: { inputTokens: 400, outputTokens: 100 } })
  await runtime.events.append("s", "Session.GoalUpdated", { sessionId: "s", objective: "finish", status: "active", tokenBudget: 100, ts: Date.now() })
  await runtime.events.append("s", "Session.Prompted", { id: "p", sessionId: "s", prompt: "go", delivery: "steer", principal: "user", promotedSeq: 99 })

  const result = await runSession(runtime, { sessionId: "s", agent, resolveTool })
  expect(result.finish).toBe("length")
  expect(result.needsContinuation).toBe(false)
  // Goal durably flipped to blocked.
  const log = await runtime.events.read("s")
  const blocked = log.filter((e) => e.type === "Session.GoalUpdated").at(-1)
  expect((blocked?.data as { status?: string }).status).toBe("blocked")
  // The model-readable pause steer was admitted (a PromptAdmitted — it is
  // promoted at the next drain, not this one).
  const admitted = log.filter((e) => e.type === "Session.PromptAdmitted")
  expect(admitted.some((e) => (e.data as { prompt?: string }).prompt?.includes("budget exhausted"))).toBe(true)
})

it("goal enforcement is skipped when the budget is not exceeded", async () => {
  let llmCalled = false
  const { runtime, resolveTool } = makeRuntime({
    id: "t",
    stream: async () => { llmCalled = true; return eventsOf([{ type: "text.delta", text: "ok" }, { type: "step-finish", finish: "stop" }]) },
  })
  await runtime.events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  await runtime.events.append("s", "Session.StepEnded", { sessionId: "s", step: 1, finish: "stop", usage: { inputTokens: 10, outputTokens: 5 } })
  await runtime.events.append("s", "Session.GoalUpdated", { sessionId: "s", objective: "small task", status: "active", tokenBudget: 100000, ts: Date.now() })
  await runtime.events.append("s", "Session.Prompted", { id: "p", sessionId: "s", prompt: "go", delivery: "steer", principal: "user", promotedSeq: 99 })
  const result = await runSession(runtime, { sessionId: "s", agent, resolveTool })
  expect(result.finish).toBe("stop")
  expect(llmCalled).toBe(true)
})

it("compaction threshold is MODEL-RELATIVE: a small window fires where the 80k default would not", async () => {
  const { runtime, resolveTool } = makeRuntime({
    id: "t",
    stream: async () => eventsOf([{ type: "text.delta", text: "final" }, { type: "step-finish", finish: "stop" }]),
  })
  await runtime.events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  // ~10 messages x ~2.1k chars ≈ 21k visible chars: under the 80k fallback,
  // over a 4k-token window's budget (4000 × 2.5 chars/token × 0.6 = 6000).
  const big = "x".repeat(2000)
  for (let i = 0; i < 10; i++) {
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "user", id: `u${i}`, seq: i * 2, text: big } })
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "assistant", id: `a${i}`, seq: i * 2 + 1, content: [{ type: "text", text: big }], model: "m" } })
  }
  await runtime.events.append("s", "Session.Prompted", { id: "p", sessionId: "s", prompt: "go", delivery: "steer", principal: "user", promotedSeq: 999 })
  await runSession(runtime, { sessionId: "s", agent, resolveTool, contextWindowTokens: 4_000 })
  expect((await runtime.events.read("s")).some((e) => e.type === "Session.Compacted")).toBe(true)
})

it("compaction stays on the 80k fallback when no window is known (same history, no fire)", async () => {
  const { runtime, resolveTool } = makeRuntime({
    id: "t",
    stream: async () => eventsOf([{ type: "text.delta", text: "final" }, { type: "step-finish", finish: "stop" }]),
  })
  await runtime.events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  const big = "x".repeat(2000)
  for (let i = 0; i < 10; i++) {
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "user", id: `u${i}`, seq: i * 2, text: big } })
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "assistant", id: `a${i}`, seq: i * 2 + 1, content: [{ type: "text", text: big }], model: "m" } })
  }
  await runtime.events.append("s", "Session.Prompted", { id: "p", sessionId: "s", prompt: "go", delivery: "steer", principal: "user", promotedSeq: 999 })
  await runSession(runtime, { sessionId: "s", agent, resolveTool })
  expect((await runtime.events.read("s")).some((e) => e.type === "Session.Compacted")).toBe(false)
})

it("explicit compactThreshold wins over the window-derived budget", async () => {
  const { runtime, resolveTool } = makeRuntime({
    id: "t",
    stream: async () => eventsOf([{ type: "text.delta", text: "final" }, { type: "step-finish", finish: "stop" }]),
  })
  await runtime.events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  const big = "x".repeat(2000)
  for (let i = 0; i < 10; i++) {
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "user", id: `u${i}`, seq: i * 2, text: big } })
    await runtime.events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "assistant", id: `a${i}`, seq: i * 2 + 1, content: [{ type: "text", text: big }], model: "m" } })
  }
  await runtime.events.append("s", "Session.Prompted", { id: "p", sessionId: "s", prompt: "go", delivery: "steer", principal: "user", promotedSeq: 999 })
  // Window would derive 6000; the explicit 1M override must win -> no fold.
  await runSession(runtime, { sessionId: "s", agent, resolveTool, contextWindowTokens: 4_000, compactThreshold: 1_000_000 })
  expect((await runtime.events.read("s")).some((e) => e.type === "Session.Compacted")).toBe(false)
})

it("compactLimit derives window-fraction budgets with explicit precedence", async () => {
  expect(compactLimit({})).toBe(80_000)
  expect(compactLimit({ contextWindowTokens: 10_000 })).toBe(15_000) // 10000×2.5×0.6
  expect(compactLimit({ contextWindowTokens: 10_000, charsPerToken: 4 })).toBe(24_000)
  expect(compactLimit({ contextWindowTokens: 10_000, compactThreshold: 999 })).toBe(999)
})

it("emits a model-io trace per completed provider call", async () => {
  const llm: TurnRuntime["llm"] = { id: "t", stream: async () => eventsOf([{ type: "text.delta", text: "hi" }, { type: "step-finish", finish: "stop", usage: { inputTokens: 3, outputTokens: 2 } } as LLMEvent]) }
  const { runtime, resolveTool } = makeRuntime(llm)
  await runtime.events.append("s1", "Session.Created", { id: "s1", location: "/proj", createdAt: 1 })
  await runtime.inbox.admit({ id: "m1", sessionId: "s1", prompt: "hello", delivery: "steer" })

  const calls: ModelCallInfo[] = []
  await runSession(runtime, { agent, sessionId: "s1", resolveTool, onModelCall: async (info) => { calls.push(info) } })

  expect(calls.length).toBe(1)
  expect(calls[0]!.model).toBe("test-model")
  expect(calls[0]!.finish).toBe("stop")
  expect(calls[0]!.outputChars).toBe(2)
  expect(calls[0]!.promptChars).toBeGreaterThan(0)
  expect(calls[0]!.toolCalls).toBe(0)
  expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0)
  expect(calls[0]!.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
})

it("model-io trace reports provider errors", async () => {
  const calls: ModelCallInfo[] = []
  const llm: TurnRuntime["llm"] = {
    id: "t",
    stream: async () => eventsOf([{ type: "provider-error", code: "http", message: "boom" } as LLMEvent]),
  }
  const { runtime, resolveTool } = makeRuntime(llm)
  await runtime.events.append("s2", "Session.Created", { id: "s2", location: "/proj", createdAt: 1 })
  await runtime.inbox.admit({ id: "m2", sessionId: "s2", prompt: "go", delivery: "steer" })

  await runSession(runtime, { agent, sessionId: "s2", resolveTool, onModelCall: async (info) => { calls.push(info) } })
  expect(calls.length).toBe(1)
  expect(calls[0]!.finish).toBe("error")
  expect(calls[0]!.error).toBe("boom")
})

it("model-io trace counts tool calls", async () => {
  const calls: ModelCallInfo[] = []
  const tool: Tool = { name: "echo", description: "echo", inputSchema: { type: "object" }, execute: async () => "ok" }
  const llm: TurnRuntime["llm"] = {
    id: "t",
    stream: async () => eventsOf([
      { type: "tool-call", id: "c1", name: "echo", input: {} } as LLMEvent,
      { type: "step-finish", finish: "tool" } as LLMEvent,
    ]),
  }
  const { runtime, resolveTool } = makeRuntime(llm, [tool])
  await runtime.events.append("s3", "Session.Created", { id: "s3", location: "/proj", createdAt: 1 })
  await runtime.inbox.admit({ id: "m3", sessionId: "s3", prompt: "go", delivery: "steer" })

  await runSession(runtime, { agent, sessionId: "s3", resolveTool, onModelCall: async (info) => { calls.push(info) } })
  expect(calls[0]!.finish).toBe("tool")
  expect(calls[0]!.toolCalls).toBe(1)
})
