import { describe, expect, it } from "bun:test"
import { createServer } from "./server"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SettingsController } from "@newhorse/runtime"

const provider = { kind: "openai", baseUrl: "https://x", apiKey: "k" } as const

/** Minimal settings controller: the /v1/file + catalog routes only read
 *  `workspace` (and the catalog loader only needs agentHome). */
function fakeSettings(workspace: string): SettingsController {
  return {
    get: () => ({ workspace, dataDir: join(workspace, ".nh-data"), allowBash: false, allowPluginCode: false, host: "127.0.0.1", port: 0, model: "m", provider: { kind: "openai", baseUrl: "https://x" }, memory: { on: false, extraction: false, vector: { enabled: false, mode: "off", embedding: { kind: "openai", baseUrl: "", model: "" } } }, approvalPolicy: "strict" }) as unknown as ReturnType<SettingsController["get"]>,
    write: async (patch) => patch as unknown as ReturnType<SettingsController["get"]>,
  }
}

describe("GET /v1/file (sandboxed file content)", () => {
  it("returns utf8 text for a small text file", async () => {
    const ws = await mkdtemp(join(tmpdir(), "nh-file-"))
    try {
      await writeFile(join(ws, "hello.txt"), "你好,世界")
      const handle = await createServer({ port: 0, sessionConfig: () => ({ provider, model: "m" }), settings: fakeSettings(ws) })
      const res = await fetch(`${handle.baseUrl}/v1/file?path=hello.txt`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { encoding: string; content: string; size: number; truncated?: boolean }
      expect(body.encoding).toBe("utf8")
      expect(body.content).toBe("你好,世界")
      expect(body.size).toBeGreaterThan(0)
      expect(body.truncated).toBeUndefined()
      await handle.stop()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it("returns base64 for binary content and 404 for missing files", async () => {
    const ws = await mkdtemp(join(tmpdir(), "nh-file-"))
    try {
      await writeFile(join(ws, "blob.bin"), new Uint8Array([0x00, 0x01, 0x02, 0xff]))
      const handle = await createServer({ port: 0, sessionConfig: () => ({ provider, model: "m" }), settings: fakeSettings(ws) })
      const res = await fetch(`${handle.baseUrl}/v1/file?path=blob.bin`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { encoding: string; content: string }
      expect(body.encoding).toBe("base64")
      expect(body.content).toBe(Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64"))

      const missing = await fetch(`${handle.baseUrl}/v1/file?path=nope.txt`)
      expect(missing.status).toBe(404)
      await handle.stop()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it("rejects path escapes and directories", async () => {
    const ws = await mkdtemp(join(tmpdir(), "nh-file-"))
    try {
      const handle = await createServer({ port: 0, sessionConfig: () => ({ provider, model: "m" }), settings: fakeSettings(ws) })
      const esc = await fetch(`${handle.baseUrl}/v1/file?path=${encodeURIComponent(join("..", "outside.txt"))}`)
      expect(esc.status).toBe(403)
      const dir = await fetch(`${handle.baseUrl}/v1/file?path=.`)
      expect(dir.status).toBe(403)
      const noPath = await fetch(`${handle.baseUrl}/v1/file`)
      expect(noPath.status).toBe(400)
      await handle.stop()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it("truncates oversized files at 2MB with truncated:true", async () => {
    const ws = await mkdtemp(join(tmpdir(), "nh-file-"))
    try {
      await writeFile(join(ws, "big.txt"), "x".repeat(2_000_500))
      const handle = await createServer({ port: 0, sessionConfig: () => ({ provider, model: "m" }), settings: fakeSettings(ws) })
      const res = await fetch(`${handle.baseUrl}/v1/file?path=big.txt`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { encoding: string; content: string; size: number; truncated?: boolean }
      expect(body.truncated).toBe(true)
      expect(body.content.length).toBe(2_000_000)
      expect(body.size).toBe(2_000_500)
      await handle.stop()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe("GET /v1/models/catalog", () => {
  it("serves the catalog from agentHome and null when absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-home-"))
    const ws = await mkdtemp(join(tmpdir(), "nh-ws-"))
    try {
      const noCatalog = await createServer({ port: 0, sessionConfig: () => ({ provider, model: "m" }), settings: fakeSettings(ws), agentHome: home })
      const absent = await fetch(`${noCatalog.baseUrl}/v1/models/catalog`)
      expect(((await absent.json()) as { catalog: unknown }).catalog).toBeNull()
      await noCatalog.stop()

      await writeFile(join(home, "model-catalog.json"), JSON.stringify({ schemaVersion: 1, providers: [{ id: "p1", models: [{ id: "m1", contextWindowTokens: 123 }] }] }))
      const handle = await createServer({ port: 0, sessionConfig: () => ({ provider, model: "m" }), settings: fakeSettings(ws), agentHome: home })
      const res = await fetch(`${handle.baseUrl}/v1/models/catalog`)
      const body = (await res.json()) as { catalog: { providers: Array<{ id: string; models: Array<{ contextWindowTokens?: number }> }> } | null }
      expect(body.catalog?.providers[0]?.id).toBe("p1")
      expect(body.catalog?.providers[0]?.models[0]?.contextWindowTokens).toBe(123)
      await handle.stop()
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe("POST /v1/channel/:id/inbound", () => {
  const payload = [
    'data: ' + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "channel says hi" }, finish_reason: "stop" }] }) + '\n\n',
    'data: [DONE]\n\n',
  ].join("")

  it("runs an inbound message through the normal prompt path", async () => {
    let providerCalls = 0
    const handle = await createServer({
      port: 0,
      channels: [{ id: "test" }],
      sessionConfig: () => ({ provider, model: "m", fetch: (() => { providerCalls++; return sse2(payload) }) as never }),
    })
    try {
      const res = await fetch(`${handle.baseUrl}/v1/channel/test/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello from the channel" }) })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { channelId: string; finish: string; reply: string }
      expect(body.channelId).toBe("test")
      expect(body.finish).toBe("stop")
      expect(body.reply).toBe("channel says hi")
      expect(providerCalls).toBe(1)

      const unknown = await fetch(`${handle.baseUrl}/v1/channel/nope/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      expect(unknown.status).toBe(404)
    } finally {
      await handle.stop()
    }
  })
})

function sse2(payload: string): Response {
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}
