import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base64ToBytes, resolveAttachmentImages } from "@newhorse/core"

function sse(payload: string): Response {
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const okPayload = [
  'data: ' + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "seen" }, finish_reason: "stop" }] }) + '\n\n',
  'data: [DONE]\n\n',
].join("")

// 1×1 red PNG (valid enough as bytes; the fake provider never decodes it)
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

describe("attachment pipeline wave 1", () => {
  it("stores image bytes once, logs refs, hydrates at lowering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-attach-"))
    try {
      const app = await createApp({
        provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
        model: "test-model",
        workspace: "/proj",
        dataDir: dir,
        fetch: (async () => sse(okPayload)) as never,
      })

      const result = await app.prompt("look at this", "user", [{ mime: "image/png", data: PNG_B64 }])
      expect(result.finish).toBe("stop")

      // The admission event carries REFS, not inline base64.
      const events = await app.events.read(app.sessionId)
      const admitted = events.find((e) => e.type === "Session.PromptAdmitted")
      const refs = (admitted?.data as { attachments?: Array<{ sha256: string; mime: string; bytes: number }> }).attachments
      expect(refs?.length).toBe(1)
      expect(refs![0]!.mime).toBe("image/png")
      expect(JSON.stringify(admitted?.data)).not.toContain(PNG_B64.slice(0, 40))

      // The bytes are in the store at <dataDir>/attachments/v1/<ab>/<sha>.
      const sha = refs![0]!.sha256
      const stored = await readFile(join(dir, "attachments", "v1", sha.slice(0, 2), sha))
      expect(new Uint8Array(stored)).toEqual(new Uint8Array(base64ToBytes(PNG_B64)!.slice()))
      expect((await stat(join(dir, "attachments", "v1", sha.slice(0, 2), sha))).size).toBe(base64ToBytes(PNG_B64)!.length)

      // The projection carries the refs on the user message.
      const session = await app.resume()
      const user = session.messages.find((m) => m.kind === "user")
      expect((user as { attachments?: unknown[] }).attachments?.length).toBe(1)

      // Lowering hydrates refs to image parts (same bytes as the original).
      const images = await resolveAttachmentImages(session.messages, app.attachments!)
      const hydrated = images.get(user!.id) ?? []
      expect(hydrated.length).toBe(1)
      expect(hydrated[0]!.mime).toBe("image/png")
      expect(hydrated[0]!.data).toBe(PNG_B64)
    } finally {
      // Windows: bun:sqlite keeps events.db open — a locked dir just stays in
      // the OS temp dir; cleanup is best-effort, never an assertion.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("deduplicates identical images into one stored object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-attach-"))
    try {
      const app = await createApp({
        provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
        model: "test-model",
        workspace: "/proj",
        dataDir: dir,
        fetch: (async () => sse(okPayload)) as never,
      })
      await app.prompt("one", "user", [{ mime: "image/png", data: PNG_B64 }])
      await app.prompt("two (same bytes)", "user", [{ mime: "image/png", data: PNG_B64 }])
      const events = await app.events.read(app.sessionId)
      const refs = events.flatMap((e) => ((e.data as { attachments?: Array<{ sha256: string }> }).attachments ?? []).map((r) => r.sha256))
      expect(refs.length).toBe(2)
      expect(new Set(refs).size).toBe(1) // same content → same address
    } finally {
      // Windows: bun:sqlite keeps events.db open — a locked dir just stays in
      // the OS temp dir; cleanup is best-effort, never an assertion.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("evicts deterministically over the per-prompt count cap (oldest first)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-attach-"))
    try {
      const app = await createApp({
        provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
        model: "test-model",
        workspace: "/proj",
        dataDir: dir,
        fetch: (async () => sse(okPayload)) as never,
      })
      // six distinct images → cap is 5, the FIRST must be evicted
      const six = Array.from({ length: 6 }, (_, i) => ({ mime: "image/png", data: Buffer.from(`image-${i}`).toString("base64") }))
      await app.prompt("six images", "user", six)
      const events = await app.events.read(app.sessionId)
      const admitted = events.find((e) => e.type === "Session.PromptAdmitted")!
      const refs = (admitted.data as { attachments?: Array<{ sha256: string }> }).attachments!
      expect(refs.length).toBe(5)
      const firstSha = (await app.attachments!.put(Buffer.from("image-0"), "image/png")).sha256
      expect(refs.some((r) => r.sha256 === firstSha)).toBe(false) // oldest evicted
      expect((admitted.data as { prompt?: string }).prompt).toContain("[images omitted")
      expect((admitted.data as { prompt?: string }).prompt).toContain("six images")
    } finally {
      // Windows: bun:sqlite keeps events.db open — a locked dir just stays in
      // the OS temp dir; cleanup is best-effort, never an assertion.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("rejects an over-cap single image with an explicit error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-attach-"))
    try {
      const app = await createApp({
        provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
        model: "test-model",
        workspace: "/proj",
        dataDir: dir,
        fetch: (async () => sse(okPayload)) as never,
      })
      const huge = Buffer.alloc(21 * 1024 * 1024, 7).toString("base64")
      expect(app.prompt("too big", "user", [{ mime: "image/png", data: huge }])).rejects.toThrow(/image too large/)
    } finally {
      // Windows: bun:sqlite keeps events.db open — a locked dir just stays in
      // the OS temp dir; cleanup is best-effort, never an assertion.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
