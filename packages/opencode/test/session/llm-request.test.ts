import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"
import { InstanceRef } from "@/effect/instance-ref"

const sessionID = "test-session-opencode"

const opencodeModel = {
  id: "opencode-go/deepseek-chat",
  providerID: "opencode-go",
  api: {
    id: "deepseek-chat",
    url: "https://opencode.example",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "DeepSeek Chat",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0 },
  limit: { context: 128_000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
} as any

const baseInput = {
  user: {
    id: "msg_user-opencode",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "opencode-go", modelID: "deepseek-chat" },
  } as any,
  sessionID,
  model: opencodeModel,
  agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
  system: [],
  messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
  tools: {},
  provider: { id: "opencode-go", options: {} } as any,
  auth: undefined,
  plugin: {
    trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  } as any,
  flags: { outputTokenMax: 32_000, client: "test" } as any,
  isWorkflow: false,
}

describe("LLMRequestPrep.prepare - opencode project header", () => {
  test("background fiber (no InstanceRef) does not die and omits x-opencode-project", async () => {
    // Regression: the daily-summary loop and other global fibers run without an
    // InstanceRef. Previously `(yield* InstanceState.context).project.id` died
    // with "InstanceRef not provided", blocking generation forever.
    const result = await Effect.runPromise(LLMRequestPrep.prepare(baseInput))
    const headers = result.headers as Record<string, string>
    expect(headers["x-opencode-session"]).toBe(sessionID)
    expect(headers["x-opencode-project"]).toBeUndefined()
  })

  test("request with InstanceRef includes x-opencode-project", async () => {
    const ctx = {
      directory: "C:/repo",
      worktree: "C:/repo",
      project: { id: "proj_123" },
    }
    const result = await Effect.runPromise(
      LLMRequestPrep.prepare(baseInput).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    const headers = result.headers as Record<string, string>
    expect(headers["x-opencode-project"]).toBe("proj_123")
  })
})
