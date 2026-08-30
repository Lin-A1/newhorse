import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "../session/store"
import { MemorySessionInput } from "../session/input"
import { Session, asSessionMessage } from "../session/session"
import { runSession } from "./loop"
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
