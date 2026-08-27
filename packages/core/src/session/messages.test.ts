import { describe, expect, it } from "bun:test"
import { toLlmMessages } from "./messages"
import type { SessionMessage } from "@newhorse/schema"

describe("toLlmMessages", () => {
  it("emits one canonical tool message per tool-result (provider-neutral)", () => {
    const projected: SessionMessage[] = [
      { kind: "user", id: "u1", seq: 0, text: "do it" },
      { kind: "assistant", id: "a1", seq: 1, content: [{ type: "tool-call", id: "c1", name: "a", input: {} }, { type: "tool-call", id: "c2", name: "b", input: {} }] },
      { kind: "tool", id: "t1", seq: 2, callId: "c1", name: "a", output: 1 },
      { kind: "tool", id: "t2", seq: 3, callId: "c2", name: "b", output: 2 },
    ]
    const messages = toLlmMessages(projected, "m")
    const toolMessages = messages.filter((m) => m.role === "tool")
    // Each result is its own canonical tool message keyed by callId; the
    // Anthropic encoder folds adjacent tool messages into one user message.
    expect(toolMessages.length).toBe(2)
    expect((toolMessages[0]!.content[0] as { id: string }).id).toBe("c1")
    expect((toolMessages[1]!.content[0] as { id: string }).id).toBe("c2")
  })

  it("lowers reasoning to plain text (drops payload) when the model differs", () => {
    const projected: SessionMessage[] = [
      { kind: "assistant", id: "a1", seq: 0, model: "model-a", content: [{ type: "reasoning", text: "think here", payload: { type: "thinking", signature: "sig" } }] },
    ]
    const kept = toLlmMessages(projected, "model-a")
    expect(kept[0]!.content).toEqual([{ type: "reasoning", text: "think here", payload: { type: "thinking", signature: "sig" } }])

    const lowered = toLlmMessages(projected, "model-b")
    expect(lowered[0]!.content).toEqual([{ type: "reasoning", text: "think here" }])
  })
})
