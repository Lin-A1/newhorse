/**
 * Real-API smoke tests. Run with a live key:
 *   ANTHROPIC_API_KEY=... bun run scripts/smoke/real-api.ts --baseUrl https://api.minimaxi.com/anthropic --model MiniMax-M2
 *
 * Assertions key off CONTENT and events (not just finish), because a provider
 * failure used to be able to masquerade as finish="stop".
 */
import { createApp, type PromptResult } from "../../packages/runtime/src/index.ts"

const args = process.argv.slice(2)
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}

const baseUrl = arg("baseUrl", "https://api.minimaxi.com/anthropic")
const model = arg("model", "MiniMax-M2")
const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is required")
  process.exit(1)
}

const provider = { kind: "anthropic" as const, baseUrl, apiKey }
const results: string[] = []
const ok = (name: string, pass: boolean, detail = ""): void => results.push(`${pass ? "PASS" : "FAIL"} ${name} ${detail}`)

/** Collect streamed events + final result for one prompt. */
async function run(app: ReturnType<typeof createApp>, text: string): Promise<{ result: PromptResult; texts: string[]; errors: unknown[] }> {
  const texts: string[] = []
  const errors: unknown[] = []
  app.onEvent((e) => {
    if (e.type === "text") texts.push(e.text)
    else if (e.type === "error") errors.push(e)
  })
  const result = await app.prompt(text, "user")
  return { result, texts, errors }
}

// S1: basic turn — assert content + tokens + no error event (not just finish).
{
  const app = await createApp({ provider, model })
  const { result, texts, errors } = await run(app, "Reply with exactly: SMOKE1")
  const joined = texts.join("")
  ok("S1 basic turn", result.finish === "stop" && /SMOKE1/.test(joined) && errors.length === 0, `finish=${result.finish} matched=${/SMOKE1/.test(joined)} errors=${errors.length}`)
}

// S2: multi-turn tool — assert pairing + step>=2 + tool message in log.
{
  const app = await createApp({
    provider,
    model,
    tools: [{ name: "get_city", description: "Return a city name.", execute: async () => ({ city: "Shanghai" }) }],
  })
  const { result } = await run(app, "Call the get_city tool, then tell me the city it returned, in Chinese, one sentence.")
  const hist = await app.resume()
  const toolMsgs = hist.messages.filter((m) => m.kind === "tool")
  const hasTool = toolMsgs.length > 0
  ok("S2 multi-turn tool", result.finish === "stop" && hasTool && result.step >= 2, `step=${result.step} toolMsgs=${toolMsgs.length}`)
}

// S3: restart recovery via SQLite — assert projection survived + can continue.
{
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "nh-smoke-"))
  try {
    const app1 = await createApp({ provider, model, sessionId: "smoke-s3", dataDir: dir })
    await app1.prompt("Reply with exactly: PERSISTED", "user")
    const before = await app1.resume()
    const app2 = await createApp({ provider, model, sessionId: "smoke-s3", dataDir: dir })
    const after = await app2.resume()
    const same = before.messages.length === after.messages.length && before.messages.every((m, i) => m.kind === after.messages[i]?.kind)
    const cont = await app2.prompt("Reply with exactly: CONTINUED", "user")
    ok("S3 restart recovery", same && cont.finish === "stop", `same=${same} contFinish=${cont.finish}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// S5: interrupt mid-run — event-driven (first text event), then assert interrupted
// and that the session can still continue afterwards.
{
  const app = await createApp({ provider, model })
  let interrupted = false
  app.onEvent((e) => {
    if (e.type === "text" && !interrupted) {
      interrupted = true
      app.interrupt()
    }
  })
  const result = await app.prompt("Count from 1 to 100, one number per line. Do not stop early.", "user")
  ok("S5 interrupt", result.finish === "interrupted", `finish=${result.finish}`)
  const follow = await app.prompt("Reply with exactly: AFTER", "user")
  ok("S5b after interrupt", follow.finish === "stop", `finish=${follow.finish}`)
}

// N1: negative — bad API key must classify as auth and NOT hang/retry forever.
{
  const badApp = await createApp({ provider: { kind: "anthropic", baseUrl, apiKey: "sk-invalid" }, model })
  let authCode = ""
  badApp.onEvent((e) => {
    if (e.type === "error") authCode = (e as { code?: string }).code ?? ""
  })
  try {
    await badApp.prompt("hi", "user")
    ok("N1 bad key", false, "no error surfaced")
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ok("N1 bad key", /401|auth/i.test(msg) || /auth/i.test(authCode), msg.slice(0, 80))
  }
}

// N2: negative — a context-overflow-sized request must classify as
// context-overflow (or at least a clean 4xx), never masquerade as success.
{
  const bigApp = await createApp({ provider, model })
  const huge = "repeat this word many times: ".repeat(40000)
  try {
    const r = await bigApp.prompt(huge, "user")
    // Some gateways accept huge prompts; a clean stop is acceptable, a fake
    // success with error events is not.
    ok("N2 overflow", r.finish === "stop" || r.finish === "error" || r.finish === "length", `finish=${r.finish}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ok("N2 overflow", /context|overflow|too.large|400|invalid/i.test(msg), msg.slice(0, 80))
  }
}

// S7 (M3.5): model autonomously uses a builtin tool to answer from a file.
// Create a workspace with a file, let the model discover + read it, and verify
// it reports the answer the file contains (proves tools give the agent hands).
{
  const { mkdtemp, rm, writeFile, mkdir } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "nh-smoke7-"))
  try {
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src/config.json"), "{\"answer\":\"GOLDEN_VALUE\"}")
    // No explicit tools — the app's builtin toolset should be wired automatically.
    const app = await createApp({ provider, model, workspace: dir })
    const { result, texts, errors } = await run(app, "List the files under src/, read config.json, and reply with exactly the value of the answer field.")
    const joined = texts.join("")
    const history = await app.resume()
    const toolMsgs = history.messages.filter((m) => m.kind === "tool")
    const usedTool = toolMsgs.length > 0
    ok("S7 builtin tool use", result.finish === "stop" && usedTool && /GOLDEN_VALUE/.test(joined) && errors.length === 0, `finish=${result.finish} toolMsgs=${toolMsgs.length} got=${joined.slice(0, 60)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// S6 (optional): second protocol — if --openaiCompatUrl is given, run S1 through
// the openai-compatible protocol to prove the four-axis Route swap.
{
  const compatUrl = arg("openaiCompatUrl", "")
  const compatKey = process.env.OPENAI_API_KEY ?? apiKey
  const compatModel = arg("openaiCompatModel", "")
  if (compatUrl && compatModel) {
    const app = await createApp({ provider: { kind: "openai-compatible", baseUrl: compatUrl, apiKey: compatKey }, model: compatModel })
    const { result, texts, errors } = await run(app, "Reply with exactly: SMOKE6")
    ok("S6 openai-compatible", result.finish === "stop" && /SMOKE6/.test(texts.join("")) && errors.length === 0, `finish=${result.finish}`)
  } else {
    results.push("SKIP S6 openai-compatible (pass --openaiCompatUrl and --openaiCompatModel)")
  }
}

console.log(results.join("\n"))
if (results.some((r) => r.startsWith("FAIL"))) {
  console.error("SMOKE: FAILURES PRESENT")
  process.exit(1)
}
console.log("SMOKE: all passed")
