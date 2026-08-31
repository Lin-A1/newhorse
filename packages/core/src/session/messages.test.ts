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

describe("image attachments (multimodal lowering)", () => {
  it("a user message with images lowers to text + image canonical parts", () => {
    const projected: SessionMessage[] = [
      { kind: "user", id: "u1", seq: 0, text: "看这张图", images: [{ mime: "image/png", data: "aGk=" }] },
    ]
    const [msg] = toLlmMessages(projected, "m")
    expect(msg?.content).toEqual([
      { type: "text", text: "看这张图" },
      { type: "image", mime: "image/png", data: "aGk=" },
    ])
  })

  it("a text-only user message stays a single text part (no regression)", () => {
    const [msg] = toLlmMessages([{ kind: "user", id: "u1", seq: 0, text: "hi" }], "m")
    expect(msg?.content).toEqual([{ type: "text", text: "hi" }])
  })
})

describe("image aging (request-size bound)", () => {
  it("only the LAST user turn carries images into the request; older turns drop them", () => {
    const img = { mime: "image/png", data: "aGk=" }
    const projected: SessionMessage[] = [
      { kind: "user", id: "u1", seq: 0, text: "第一张", images: [img] },
      { kind: "assistant", id: "a1", seq: 1, content: [{ type: "text", text: "收到" }] },
      { kind: "user", id: "u2", seq: 2, text: "再看", images: [img] },
    ]
    const msgs = toLlmMessages(projected, "m")
    const kinds = msgs.map((m) => m.content.filter((p) => p.type === "image").length)
    expect(kinds).toEqual([0, 0, 1])
  })
})
