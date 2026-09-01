/**
 * Local fake OpenAI-compatible LLM for UI/visual verification.
 * Emits: reasoning deltas → tool calls (read + todo_write) → then a rich
 * markdown final answer with code + diff blocks. Run:  bun run scripts/fake-llm.ts
 */
const PORT = 4141

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const FINAL_MD = `## 仓库结构总结

这是一个 **Bun + TypeScript** 的单仓多包（monorepo）项目，引擎与宿主分层清晰。

主要目录：

- \`packages/\` — 引擎本体（schema / core / llm / runtime / server …）
- \`apps/\` — 宿主（web 客户端、desktop 外壳）
- \`docs/\` — 核心技术设计笔记

一个最小的运行时装配长这样：

\`\`\`ts
import { createServer } from "@newhorse/runtime"

const handle = await createServer({
  provider: { kind: "anthropic", baseUrl: process.env.LLM_BASE_URL },
  model: "mini",
})
console.log(handle.baseUrl)
\`\`\`

最近这次改动里，会话标题的取法也调整了：

\`\`\`diff
- title = raw assistant text (会很长)
+ title = first user message, clipped to 24 chars
\`\`\`

整体建议：先跑 \`bun test\` 确认引擎绿灯，再看 UI。需要我继续深入哪一块？`

async function streamResponse(hasToolResult: boolean): Promise<Response> {
  const enc = new TextEncoder()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async (obj: unknown, delay = 140): Promise<void> => {
        await sleep(delay)
        controller.enqueue(enc.encode(sse(obj)))
      }
      if (!hasToolResult) {
        await send({ choices: [{ delta: { role: "assistant", content: "" } }] }, 900)
        await send({ choices: [{ delta: { reasoning_content: "先检索仓库结构" } }] }, 600)
        await send({ choices: [{ delta: { reasoning_content: "，再读说明文件、拆任务清单。" } }] }, 600)
        await send(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "search", arguments: JSON.stringify({ query: "workspace layout" }) } }] } }] },
          300,
        )
        await send(
          { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "AGENTS.md", limit: 40 }) } }] } }] },
          1600,
        )
        await send(
          { choices: [{ delta: { tool_calls: [{ index: 2, id: "call_todo", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "读取仓库结构", status: "completed", activeForm: "读取仓库结构" }, { content: "总结架构与技术栈", status: "in_progress", activeForm: "总结架构" }, { content: "输出报告并给建议", status: "pending", activeForm: "输出报告" }] }) } }] } }] },
          1800,
        )
        const demoContent = ["# 演示笔记", "", "fake-llm 写入的演示文件，用于验证变更文件面板。", "- 第一行要点", "- 第二行要点", ""].join("\n")
        await send(
          { choices: [{ delta: { tool_calls: [{ index: 3, id: "call_write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "nh-smoke-demo/演示.md", content: demoContent }) } }] } }] },
          1500,
        )
        await send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, 120)
      } else {
        await send({ choices: [{ delta: { role: "assistant", content: "" } }] }, 60)
        const words = FINAL_MD.split("")
        let buf = ""
        for (let i = 0; i < words.length; i++) {
          buf += words[i]
          if (buf.length >= 6 || i === words.length - 1) {
            await send({ choices: [{ delta: { content: buf } }] }, 28)
            buf = ""
          }
        }
        await send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5234, completion_tokens: 640 } }, 100)
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "fake-mini" }, { id: "fake-pro" }], object: "list" })
    }
    if (url.pathname === "/v1/chat/completions") {
      const payload = (await req.json().catch(() => ({}))) as { messages?: Array<{ role?: string }> }
      const hasToolResult = (payload.messages ?? []).some((m) => m.role === "tool")
      return streamResponse(hasToolResult)
    }
    return new Response("not found", { status: 404 })
  },
})

console.log(`fake LLM listening on http://127.0.0.1:${PORT} (openai-compatible)`)
