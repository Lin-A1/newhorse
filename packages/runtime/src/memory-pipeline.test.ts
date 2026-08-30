import { describe, expect, it } from "bun:test"
import { createDefaultMemoryPipeline } from "./memory-pipeline"
import type { LlmClient } from "@newhorse/llm"
import type { LLMEvent } from "@newhorse/schema"

function eventsOf(events: LLMEvent[]): AsyncIterable<LLMEvent> {
  return (async function* () {
    for (const e of events) yield e
  })()
}

/** Replay a fixed text per call for a stub client. */
function stubClient(...texts: string[]): LlmClient {
  let i = 0
  return {
    id: "stub",
    stream: async () => {
      const text = texts[Math.min(i, texts.length - 1)]!
      i++
      return eventsOf([{ type: "text.delta", text }])
    },
  }
}

describe("createDefaultMemoryPipeline", () => {
  it("extract parses the JSON array from a plain-text LLM response", async () => {
    const pipe = createDefaultMemoryPipeline(stubClient(`Here are the facts:\n[{"content":"user likes ts","type":"persona","priority":80}]`), "m")
    const out = await pipe.extractL1MemoNext({ messages: [{ role: "user", text: "I like ts" }], candidates: [] })
    expect(out.length).toBe(1)
    expect(out[0]!.content).toBe("user likes ts")
    expect(out[0]!.type).toBe("persona")
    expect(out[0]!.priority).toBe(80)
  })

  it("dedup parses actions and clamps unknown types", async () => {
    const pipe = createDefaultMemoryPipeline(stubClient(`[{"action":"skip"},{"action":"store"},{"action":"merge","targetIds":["c1"],"mergedType":"whatever"}]`), "m")
    const out = await pipe.dedupMemories({ extracted: [{ content: "a", type: "fact", priority: 10 }, { content: "b", type: "fact", priority: 10 }], candidates: [] })
    expect(out[0]!.action).toBe("skip")
    expect(out[1]!.action).toBe("store")
    expect(out[2]!.action).toBe("merge")
    expect(out[2]!.targetIds).toEqual(["c1"])
    expect(out[2]!.mergedType).toBeUndefined() // "whatever" is rejected
  })

  it("garbage output yields empty (never throws)", async () => {
    const pipe = createDefaultMemoryPipeline(stubClient("no json here"), "m")
    const out = await pipe.extractL1MemoNext({ messages: [], candidates: [] })
    expect(out.length).toBe(0)
  })
})

it("clamps model-emitted priority into [0,100] (500 -> 100; negative -> 50)", async () => {
  const pipe = createDefaultMemoryPipeline(stubClient(`[{"content":"over","type":"fact","priority":500},{"content":"under","type":"fact","priority":-3}]`), "m")
  const out = await pipe.extractL1MemoNext({ messages: [], candidates: [] })
  expect(out[0]!.priority).toBe(100)
  expect(out[1]!.priority).toBe(50)
})
