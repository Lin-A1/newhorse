/**
 * Minimal MCP server fixture for tests: speaks newline-delimited JSON-RPC 2.0
 * on stdin/stdout. Exposes one tool "echo" and one allowlist-blockable tool
 * "secret". Run: bun test/fixture-server.ts
 */
import { createInterface } from "node:readline"

const rl = createInterface({ input: process.stdin })
const write = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

rl.on("line", (line) => {
  let msg: { id?: number; method?: string; params?: Record<string, unknown> }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // notification
  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.0.1" } } })
  } else if (msg.method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          { name: "echo", description: "Echo the input text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          { name: "secret", description: "Hidden tool for allowlist tests.", inputSchema: { type: "object" } },
        ],
      },
    })
  } else if (msg.method === "tools/call") {
    const args = (msg.params?.arguments ?? {}) as { text?: string }
    write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }], isError: false } })
  } else {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
  }
})
