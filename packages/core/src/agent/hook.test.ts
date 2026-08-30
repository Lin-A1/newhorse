import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "../session/store"
import { MemorySessionInput } from "../session/input"
import { runSession } from "./loop"
import type { TurnRuntime, Tool } from "./runner"
import type { LLMEvent, LLMRequest } from "@newhorse/schema"

function eventsOf(events: LLMEvent[]): AsyncIterable<LLMEvent> {
  return (async function* () {
    for (const e of events) yield e
  })()
}

function stubLlm(turns = 2): TurnRuntime["llm"] {
  let n = 0
  return {
    id: "t",
    stream: async (req) => {
      const text = (req.messages.find((m) => m.role === "user")?.content[0] as { text?: string } | undefined)?.text ?? ""
      n++
      const finishing = n >= turns
      return eventsOf([
        { type: "text.delta", text: `turn${n}: ${text}` },
        ...(finishing ? [{ type: "step-finish", finish: "stop" } as const] : []),
      ])
    },
  }
}

const noopTool: Tool = { name: "t", execute: async () => "done" }

describe("hook seam (loop)", () => {
  it("a stop hook block re-injects a reason and continues (loop-until-done)", async () => {
    const events = new MemoryEventStore()
    const inbox = new MemorySessionInput(events)
    await events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
    await inbox.admit({ id: "p1", sessionId: "s", prompt: "work", delivery: "steer" })

    let stopCalls = 0
    const result = await runSession({ events, inbox, llm: stubLlm(2) }, {
      sessionId: "s",
      agent: { id: "a", model: "m" },
      resolveTool: () => noopTool,
      runHooks: async (event) => {
        if (event === "stop") {
          stopCalls++
          // First stop: force another step. Second: let it settle.
          return { decision: stopCalls === 1 ? "block" : "allow", reason: "keep going" }
        }
        return { decision: "allow" }
      },
    })
    expect(result.step).toBeGreaterThanOrEqual(2)
    expect(result.finish).toBe("stop")
    // The block's reason was admitted as a steer (model saw it).
    const log = await events.read("s")
    const prompted = log.filter((e) => e.type === "Session.Prompted")
    expect(prompted.some((e) => (e.data as { prompt?: string }).prompt === "keep going")).toBe(true)
  })

  it("pre-tool-use block skips the tool and records the denial as an error result", async () => {
    const events = new MemoryEventStore()
    const inbox = new MemorySessionInput(events)
    await events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
    await inbox.admit({ id: "p1", sessionId: "s", prompt: "call tool", delivery: "steer" })

    const llm: TurnRuntime["llm"] = {
      id: "t",
      stream: async () => eventsOf([
        { type: "tool-call", id: "tc1", name: "t", input: "{}" },
        { type: "step-finish", finish: "stop" },
      ]),
    }
    await runSession({ events, inbox, llm }, {
      sessionId: "s",
      agent: { id: "a", model: "m" },
      resolveTool: () => noopTool,
      runHooks: async (event) => event === "pre-tool-use" ? { decision: "block", reason: "hook says no" } : { decision: "allow" },
    })
    const log = await events.read("s")
    const toolResult = log.find((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "tool")
    expect((toolResult?.data as { message?: { isError?: boolean; output?: string } }).message?.isError).toBe(true)
    expect((toolResult?.data as { message?: { output?: string } }).message?.output).toContain("hook says no")
  })
})
