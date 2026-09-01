import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { createMcpTools } from "./src/index"

const here = import.meta.dir

describe("mcp client seam", () => {
  it("mounts a stdio server's tools as Tool[] and executes them", async () => {
    const mcp = await createMcpTools({
      fixture: { command: process.execPath, args: [join(here, "test/fixture-server.ts")] },
    })
    try {
      expect(mcp.tools.map((t) => t.name).sort()).toEqual(["mcp__fixture__echo", "mcp__fixture__secret"])
      const echo = mcp.tools.find((t) => t.name === "mcp__fixture__echo")!
      expect(echo.description).toContain("Echo the input text")
      expect(echo.sideEffects).toBe(true) // conservative: third-party effects unknown
      expect(await echo.execute({ text: "hello" })).toBe("echo:hello")
    } finally {
      await mcp.dispose()
    }
  })

  it("honors allowedTools as a per-server allowlist", async () => {
    const mcp = await createMcpTools({
      fixture: { command: process.execPath, args: [join(here, "test/fixture-server.ts")], allowedTools: ["echo"] },
    })
    try {
      expect(mcp.tools.map((t) => t.name)).toEqual(["mcp__fixture__echo"])
    } finally {
      await mcp.dispose()
    }
  })

  it("fail-soft: a dead server contributes zero tools, enabled:false is skipped", async () => {
    const dead = await createMcpTools({
      nope: { command: process.execPath, args: ["-e", "process.exit(1)"] },
      off: { enabled: false, command: process.execPath, args: [join(here, "test/fixture-server.ts")] },
    })
    try {
      expect(dead.tools).toEqual([])
    } finally {
      await dead.dispose()
    }
  })

  it("mounts an http server (streamable POST, JSON body replies)", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST") return new Response("no", { status: 405 })
        const msg = (await req.json()) as { id: number; method: string; params?: { arguments?: { text?: string } } }
        if (msg.method === "initialize") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "http-fixture", version: "0" } } }), { headers: { "content-type": "application/json", "mcp-session-id": "s-1" } })
        }
        if (msg.method === "tools/list") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "shout", description: "Shout text.", inputSchema: { type: "object" } }] } }), { headers: { "content-type": "application/json" } })
        }
        if (msg.method === "tools/call") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `SHOUT:${msg.params?.arguments?.text ?? ""}` }] } }), { headers: { "content-type": "application/json" } })
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }), { headers: { "content-type": "application/json" } })
      },
    })
    try {
      const mcp = await createMcpTools({ http: { url: `http://127.0.0.1:${server.port}/mcp` } })
      try {
        expect(mcp.tools.map((t) => t.name)).toEqual(["mcp__http__shout"])
        expect(await mcp.tools[0]!.execute({ text: "hi" })).toBe("SHOUT:hi")
      } finally {
        await mcp.dispose()
      }
    } finally {
      server.stop(true)
    }
  })
})
