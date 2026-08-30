import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import type { Fetcher } from "@newhorse/llm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function sseToolCall(name: string, args: string): Response {
  const toolChunk: unknown = { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "tc1", function: { name, arguments: args } }] }, finish_reason: null }] }
  const finalChunk: unknown = { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }
  const payload = ["data: " + JSON.stringify(toolChunk) + "\n\n", "data: " + JSON.stringify(finalChunk) + "\n\n", "data: [DONE]\n\n"].join("")
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function sseText(text: string): Response {
  const chunk: unknown = { choices: [{ delta: { content: text }, finish_reason: "stop" }] }
  return new Response("data: " + JSON.stringify(chunk) + "\n\n" + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("plan-mode loop (readonly → request_mode → approved execution)", () => {
  it("readonly session: model plans (todo), requests mode change, host approves, tools widen", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nh-plan-"))
    let turn = 0
    // Turn script: 1) todo_write the plan, 2) request_mode, 3) (approved) write the file.
    const fetch: Fetcher = async () => {
      turn++
      if (turn === 1) return sseToolCall("todo_write", JSON.stringify({ todos: [{ content: "plan the fix", status: "completed" }] }))
      if (turn === 2) return sseToolCall("request_mode", JSON.stringify({ target: "strict", reason: "plan complete, ready to execute" }))
      if (turn === 3) return sseToolCall("write", JSON.stringify({ path: "executed.txt", content: "done" }))
      return sseText("finished")
    }
    try {
      // The host auto-approves mode changes (the IDE's approve gate in tests).
      const app = await createApp({
        provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace,
        approvalPolicy: "readonly",
        onApprove: async (req) => req.kind === "mode" && req.target === "strict",
        fetch,
      })
      await app.prompt("plan then execute", "user")

      // Policy durably changed (model-approved).
      const policy = app.policy()
      expect(policy).toBe("strict")
      const log = await app.events.read(app.sessionId)
      const changed = log.filter((e) => e.type === "Session.PolicyChanged")
      expect(changed.length).toBe(1)
      expect(changed[0]!.data.from).toBe("readonly")
      expect(changed[0]!.data.to).toBe("strict")
      expect(changed[0]!.data.by).toBe("model-approved")
      // The execution actually ran: the file exists (write was allowed post-approval).
      const { readFile } = await import("node:fs/promises")
      expect(await readFile(join(workspace, "executed.txt"), "utf8")).toBe("done")
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("host denial keeps readonly (the model sees the denial, nothing escalates)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nh-plan-deny-"))
    let turn = 0
    const fetch: Fetcher = async () => {
      turn++
      if (turn === 1) return sseToolCall("request_mode", JSON.stringify({ target: "trusted", reason: "let me do everything" }))
      return sseText("understood")
    }
    try {
      const app = await createApp({
        provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace,
        approvalPolicy: "readonly",
        onApprove: async () => false, // host denies
        fetch,
      })
      await app.prompt("try to escape", "user")
      expect(app.policy()).toBe("readonly") // unchanged
      const log = await app.events.read(app.sessionId)
      expect(log.some((e) => e.type === "Session.PolicyChanged")).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {})
    }
  })
})
