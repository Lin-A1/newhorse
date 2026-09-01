/**
 * Client-surfaces smoke — no API key required (the LLM is a local stub).
 *
 *   bun run scripts/smoke/client-surfaces.ts
 *
 * Exercises the client-facing transport surfaces added for the web client:
 *   T1 butler create → registry role
 *   T2 image prompt → durable once on the admit, projection resolves
 *   T3 image-only prompt (empty text) is valid
 *   T4 transport validation: unknown mime / non-base64 / oversized / too many → 400
 *   T5 slash commands: catalog + $ARGUMENTS expansion + unknown → 404
 *   T6 per-session policy GET/POST (+ invalid value 400)
 *   T7 provider presets: upsert/activate/clear/remove through PUT /v1/settings
 *   T8 fork preserves source workspace + role
 *   T9 body read is bounded before parse (declared length over the cap → 413)
 */
import { createServer, type ServerHandle } from "../../packages/server/src/server"
import { loadRuntimeSettings, writeAgentHomeConfig } from "../../packages/runtime/src/index.ts"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const results: string[] = []
const ok = (name: string, pass: boolean, detail = ""): void => { results.push(`${pass ? "PASS" : "FAIL"} ${name} ${detail}`) }

// --- stub LLM (openai-compatible SSE): one text delta then stop ---
const stub = Bun.serve({
  port: 0,
  fetch: async () =>
    new Response(
      ["data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "stub: " }, finish_reason: null }] }) + "\n\n", "data: " + JSON.stringify({ choices: [{ delta: { content: "ACKED" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
})

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const pluginsDir = await mkdtemp(join(tmpdir(), "nh-smoke-plugins-"))
const dataDir = await mkdtemp(join(tmpdir(), "nh-smoke-data-"))
// ISOLATED agent home: the settings endpoints write the config file — never
// let a smoke run touch the developer's real ~/.newhorse.
const agentHome = await mkdtemp(join(tmpdir(), "nh-smoke-home-"))
let handle: ServerHandle | undefined
try {
  await mkdir(join(pluginsDir, "commands"), { recursive: true })
  await writeFile(join(pluginsDir, "commands", "greet.md"), "---\ndescription: 打招呼\n---\n你好，$ARGUMENTS！请处理这条命令。", "utf8")

  handle = await createServer({
    port: 0,
    pluginsDir,
    sessionConfig: (create) => ({
      provider: { kind: "openai" as const, baseUrl: `http://127.0.0.1:${stub.port}`, apiKey: "stub" },
      model: "stub-model",
      asButler: create.asButler === true,
      workspace: "/proj-smoke",
      dataDir,
      // sessions must discover plugin commands ($ARGUMENTS path)
      pluginsDir,
      fetch: (() => fetch(`http://127.0.0.1:${stub.port}/v1/chat/completions`, { method: "POST" })) as never,
    }),
    settings: {
      get: () => loadRuntimeSettings({ agentHome, env: {} }),
      write: async (patch) => {
        await writeAgentHomeConfig(agentHome, patch)
        return loadRuntimeSettings({ agentHome, env: {} })
      },
    },
  })
  const base = handle.baseUrl
  const sid = async (body: Record<string, unknown>): Promise<string> => ((await post(base, "/v1/session", body)).json as { sessionId: string }).sessionId

  // T1 butler role lands in the durable registry
  const butler = await sid({ asButler: true })
  const rows = (await (await fetch(`${base}/v1/sessions`)).json()) as Array<{ sessionId: string; role?: string }>
  ok("T1 butler create → registry role=butler", rows.find((r) => r.sessionId === butler)?.role === "butler")

  // T2 image prompt: stored once on the admit; the snapshot projection resolves it
  const imgSession = await sid({})
  // drive one prompt over SSE to completion
  const res = await fetch(`${base}/v1/session/${imgSession}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "看这张图", images: [{ mime: "image/png", data: PNG_B64 }] }) })
  await res.text()
  const evs = (await (await fetch(`${base}/v1/session/${imgSession}/events`)).json()) as Array<{ type: string; data: Record<string, unknown> }>
  const admitted = evs.filter((e) => e.type === "Session.PromptAdmitted").pop()
  const prompted = evs.filter((e) => e.type === "Session.Prompted").pop()
  const storedOnce = (admitted?.data.images as unknown[] | undefined)?.length === 1 && prompted?.data.images === undefined
  const snap = (await (await fetch(`${base}/v1/session/${imgSession}`)).json()) as { messages?: Array<{ kind: string; images?: unknown[] }> }
  const userWithImage = (snap.messages ?? []).some((m) => m.kind === "user" && Array.isArray(m.images) && m.images.length === 1)
  ok("T2 image stored once + projection resolves", storedOnce && userWithImage, `storedOnce=${storedOnce} projected=${userWithImage}`)

  // T3 image-only prompt (empty text) is accepted
  const r3 = await post(base, `/v1/session/${imgSession}/prompt`, { text: "", images: [{ mime: "image/webp", data: PNG_B64 }] })
  ok("T3 image-only prompt accepted", r3.status === 200, `status=${r3.status}`)

  // T4 transport validation — each rejection is an explicit 400
  const badMime = await post(base, `/v1/session/${imgSession}/prompt`, { text: "x", images: [{ mime: "application/x-evil", data: PNG_B64 }] })
  const badB64 = await post(base, `/v1/session/${imgSession}/prompt`, { text: "x", images: [{ mime: "image/png", data: "!!!not-base64!!!" }] })
  const oversized = await post(base, `/v1/session/${imgSession}/prompt`, { text: "x", images: [{ mime: "image/png", data: "A".repeat(4_000_001) }] })
  const tooMany = await post(base, `/v1/session/${imgSession}/prompt`, { text: "x", images: Array.from({ length: 6 }, () => ({ mime: "image/png", data: PNG_B64 })) })
  ok("T4 validation 400s (mime/base64/size/count)", badMime.status === 400 && badB64.status === 400 && oversized.status === 400 && tooMany.status === 400, `${badMime.status}/${badB64.status}/${oversized.status}/${tooMany.status}`)

  // T5 slash commands: catalog, $ARGUMENTS expansion, unknown → 404
  const cmds = (await (await fetch(`${base}/v1/commands`)).json()) as { commands: Array<{ name: string }> }
  const cmdSession = await sid({})
  const expanded = await post(base, `/v1/session/${cmdSession}/command`, { text: "/greet 世界和咖啡" })
  const unknown = await post(base, `/v1/session/${cmdSession}/command`, { text: "/nope" })
  const expansion = String((expanded.json as { output?: string }).output)
  ok("T5 commands catalog + $ARGUMENTS + 404", cmds.commands.some((c) => c.name === "greet") && expansion.includes("世界和咖啡") && !expansion.startsWith("---") && unknown.status === 404, `frontmatterLeak=${expansion.startsWith("---")}`)

  // T6 per-session policy
  const polSession = await sid({})
  const p0 = (await (await fetch(`${base}/v1/session/${polSession}/policy`)).json()) as { policy: string }
  const p1 = await post(base, `/v1/session/${polSession}/policy`, { policy: "readonly" })
  const p2 = (await (await fetch(`${base}/v1/session/${polSession}/policy`)).json()) as { policy: string }
  const pBad = await post(base, `/v1/session/${polSession}/policy`, { policy: "root" })
  ok("T6 policy GET/POST + invalid 400", p0.policy === "strict" && p1.status === 200 && p2.policy === "readonly" && pBad.status === 400)

  // T7 provider presets through PUT /v1/settings
  const put = async (body: unknown): Promise<unknown> => (await fetch(`${base}/v1/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()
  await put({ providers: [{ id: "ds", name: "DS", kind: "openai-compatible", baseUrl: "https://ds.example", apiKey: "sk-smoke", model: "ds-chat", contextWindowTokens: 64000 }], activeProviderId: "ds" })
  const s1 = (await (await fetch(`${base}/v1/settings`)).json()) as { activeProviderId?: string; model: string; provider: { baseUrl: string }; providers?: Array<{ hasApiKey: boolean; apiKey?: string }> }
  await put({ providers: [{ id: "ds", model: "", contextWindowTokens: "", apiKey: "" }] })
  const s2 = (await (await fetch(`${base}/v1/settings`)).json()) as { providers?: Array<{ model?: string; contextWindowTokens?: number; hasApiKey: boolean }> }
  await put({ providersRemove: ["ds"] })
  const s3 = (await (await fetch(`${base}/v1/settings`)).json()) as { activeProviderId?: string; providers?: unknown[] }
  const view = await fetch(`${base}/v1/settings`).then((r) => r.json()) as { providers?: Array<{ apiKey?: string }> }
  const noSecret = (view.providers ?? []).every((p) => p.apiKey === undefined)
  ok(
    "T7 presets activate/clear/remove + redaction",
    s1.activeProviderId === "ds" && s1.model === "ds-chat" && s1.provider.baseUrl === "https://ds.example" && (s2.providers?.[0]?.model === undefined) && (s2.providers?.[0]?.hasApiKey === true) && s3.activeProviderId === undefined && s3.providers === undefined && noSecret,
    `redacted=${noSecret}`,
  )

  // T8 fork preserves source workspace + role
  const forkSrc = await sid({ asButler: true })
  await post(base, `/v1/session/${forkSrc}/prompt`, { text: "turn one" })
  const fork = (await post(base, `/v1/session/${forkSrc}/fork`, {})).json as { sessionId: string }
  await post(base, "/v1/session", { sessionId: fork.sessionId, asButler: true })
  const forkEvents = (await (await fetch(`${base}/v1/session/${fork.sessionId}/events`)).json()) as Array<{ type: string; data: { location?: string; role?: string } }>
  const created = forkEvents.find((e) => e.type === "Session.Created")
  ok("T8 fork keeps workspace + role", created?.data.location === "/proj-smoke" && created?.data.role === "butler")

  // T9 body read bound: a REAL >40MB body is rejected 413 before JSON parse
  const pad = "A".repeat(41_000_000)
  const huge = await fetch(`${base}/v1/session/${imgSession}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x", pad }),
  })
  ok("T9 oversized body → 413", huge.status === 413, `status=${huge.status}`)
} finally {
  await handle?.stop()
  stub.stop(true)
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  await rm(agentHome, { recursive: true, force: true }).catch(() => {})
}
console.log(results.join("\n"))
if (results.some((r) => r.startsWith("FAIL"))) {
  console.log("SMOKE: FAILURES")
  process.exit(1)
}
console.log("SMOKE: all passed")
