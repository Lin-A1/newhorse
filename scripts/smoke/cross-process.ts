/**
 * Cross-process SessionManager smoke (M4). No API key required — the LLM is a
 * local stub server, so the cross-process MECHANISM is what's under test:
 *
 *   bun run scripts/smoke/cross-process.ts
 *
 * 1. Two real server processes-worth of routing (two createServer instances on
 *    distinct ports) share one SQLite session directory.
 * 2. A session created on A is observed / steered / interrupted FROM B over
 *    the HTTP proxy path.
 * 3. A dead owner 502s and its stale directory entry self-heals (sweep).
 * 4. An SSE prompt streamed through the B→A proxy relays events end to end.
 */
import { createServer, type ServerHandle } from "../../packages/server/src/server"
import { createSqliteSessionDirectory } from "../../packages/runtime/src/session-directory"

const results: string[] = []
const ok = (name: string, pass: boolean, detail = ""): void => { results.push(`${pass ? "PASS" : "FAIL"} ${name} ${detail}`) }

// --- local LLM stub: an openai-compatible SSE endpoint with two modes ---
let hangRequests = false
const stub = Bun.serve({
  port: 0,
  fetch: async () => {
    if (hangRequests) await new Promise(() => {}) // hang forever (interrupt target)
    const body = [
      "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "stub: " }, finish_reason: null }] }) + "\n\n",
      "data: " + JSON.stringify({ choices: [{ delta: { content: "ACKED" }, finish_reason: "stop" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  },
})
const provider = { kind: "openai" as const, baseUrl: `http://127.0.0.1:${stub.port}`, apiKey: "stub" }

const { mkdtemp, rm } = await import("node:fs/promises")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")
const dir = await mkdtemp(join(tmpdir(), "nh-xp-smoke-"))
const registry = join(dir, "registry.db")

try {
  const directory = createSqliteSessionDirectory(registry)
  const mkServer = (): Promise<ServerHandle> => createServer({
    port: 0,
    directory,
    sessionConfig: () => ({ provider, model: "stub-model", workspace: dir }),
  })
  const a = await mkServer()
  const b = await mkServer()

  // 1. Create on A; observe from B (proxy).
  const created = await fetch(`${a.baseUrl}/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "xp" }) })
  ok("create on A", created.status === 201, `status=${created.status}`)
  const snap = await fetch(`${b.baseUrl}/v1/session/xp`)
  ok("snapshot proxied via B", snap.status === 200, `status=${snap.status}`)

  // 2. Prompt THROUGH B (SSE relay), assert the stub's answer arrives.
  hangRequests = false
  const prompt = await fetch(`${b.baseUrl}/v1/session/xp/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })
  const streamText = await prompt.text()
  ok("prompt via B proxy streams", prompt.status === 200 && streamText.includes("ACKED") && streamText.includes("[DONE]"), `status=${prompt.status} bytes=${streamText.length}`)

  // 3. Steer + interrupt a HUNG run from B (proxy into A's live inbox).
  hangRequests = true
  const hung = await fetch(`${b.baseUrl}/v1/session/xp/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "long" }) })
  void hung // headers only; the run hangs in the stub
  const steer = await fetch(`${b.baseUrl}/v1/session/xp/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "focus" }) })
  ok("steer via B", steer.status === 200, `status=${steer.status}`)
  const interrupt = await fetch(`${b.baseUrl}/v1/session/xp/interrupt`, { method: "POST" })
  ok("interrupt via B", interrupt.status === 200, `status=${interrupt.status}`)
  // The stub hangs forever; the interrupt must land IN the hung request.
  await new Promise((r) => setTimeout(r, 300))
  const events = await (await fetch(`${b.baseUrl}/v1/session/xp/events`)).json() as { type: string; data: Record<string, unknown> }[]
  ok("interrupt settled durably", events.some((e) => e.type === "Session.Interrupted"), events.map((e) => e.type).slice(-3).join(","))

  // 4. Live view + dead-owner sweep.
  const live = await (await fetch(`${b.baseUrl}/v1/live`)).json() as { live: { sessionId: string; endpoint: string }[] }
  ok("directory live view", live.live.some((e) => e.sessionId === "xp" && e.endpoint === a.baseUrl), JSON.stringify(live.live.length))

  await a.stop()
  // Stale row pointing at the dead endpoint (the crash-without-cleanup shape).
  directory.register("crashed", a.baseUrl)
  const dead = await fetch(`${b.baseUrl}/v1/session/crashed`)
  ok("dead owner 502 + swept", dead.status === 502 && directory.lookup("crashed") === undefined, `status=${dead.status}`)

  await b.stop()
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  stub.stop(true)
}

console.log(results.join("\n"))
if (results.some((r) => r.startsWith("FAIL"))) {
  console.error("SMOKE: FAILURES PRESENT")
  process.exit(1)
}
console.log("SMOKE: all passed")
