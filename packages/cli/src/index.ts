import { createApp } from "@newhorse/runtime"
import type { AdapterConfig } from "@newhorse/llm"
import type { SessionMessage, ApprovalRequest } from "@newhorse/schema"
import { createInterface } from "node:readline"
import { join, resolve } from "node:path"

/**
 * CLI entrypoint. Reads a single prompt from argv or stdin, runs one session,
 * and prints the visible history. Transport only — all domain logic lives in
 * the runtime/core layers.
 *
 * Long-horizon (goal #2): sessions persist to a `dataDir` with a stable
 * `sessionId` (default derived from the workspace) so a restart re-attaches to
 * the prior log instead of starting a fresh, empty session. Both are
 * overridable via `--data-dir` / `--session` (and their env vars).
 */
export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)

  // `newhorse dag <file.json>` — declarative DAG scheduling: load a DAGSpec,
  // run it, print per-node progress/results. The transport only parses +
  // renders; runDag lives in the runtime.
  if (args.dag) {
    await runDagCli(resolve(args.dag))
    return
  }

  const config: AdapterConfig = resolveProvider(args)
  const app = await createApp({
    provider: config,
    model: args.model ?? "gpt-4o-mini",
    workspace: process.cwd(),
    sessionId: resolveSessionId(args),
    dataDir: resolveDataDir(args),
    pluginsDir: args["plugins-dir"] ? resolve(args["plugins-dir"]) : undefined,
    asButler: args.butler ? true : false,
    // M4 execpolicy: the transport owns the interactive approve gate. A prompt-
    // level tool decision (command/path) is surfaced to the user as a y/n
    // question; declining (or a non-TTY) fails closed to deny.
    onApprove: async (req: ApprovalRequest): Promise<boolean> => {
      const label = req.kind === "command" ? "command" : "path write"
      return askUser(`\u001b[33m[execpolicy] ${label}: ${req.target}\u001b[0m allow? (y/N) `)
    },
  })

  // Interactive REPL when no --prompt was given: Ctrl-C interrupts the current
  // run, /steer / /list / /interrupt / <text> drive the session.
  if (args.prompt === undefined && !process.env.NEWHORSE_NO_REPL) {
    await repl(app)
    return
  }

  const promptText = args.prompt ?? (await readStdin())
  if (!promptText) {
    console.error("usage: newhorse [--provider ...] [--model NAME] [--prompt TEXT] [--butler] [--dag FILE] [--data-dir DIR] [--session ID] [--plugins-dir DIR]")
    return
  }

  // Render streamed model output live; then only print user prompts from history
  // (assistant text was already streamed — avoid double-printing it).
  app.onEvent((event) => {
    if (event.type === "text") process.stdout.write(event.text)
    else if (event.type === "reasoning") process.stdout.write(`\u001b[2m${event.text}\u001b[0m`)
    else if (event.type === "error") process.stderr.write(`\u001b[31m${event.message}\u001b[0m\n`)
  })
  // A slash-command line ("/name args") resolves against the plugin registry's
  // command capabilities — the transport never interprets commands itself.
  if (promptText.startsWith("/")) {
    const output = await app.runCommand(promptText)
    if (output === undefined) {
      console.error(`\u001b[31munknown command: ${promptText.split(" ")[0]}\u001b[0m`)
      return
    }
    console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2))
    return
  }
  await app.prompt(promptText, "user")
  const history = await app.resume()
  console.log()
  for (const message of history.messages) {
    if (message.kind === "user") printMessage(message)
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`\u001b[31m${message}\u001b[0m`)
    process.exitCode = 1
  })
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      out[key] = argv[i + 1] ?? "true"
      i++
    }
  }
  return out
}

function resolveProvider(args: Record<string, string>): AdapterConfig {
  const rawKind = args.provider ?? process.env.NEWHORSE_PROVIDER ?? "openai"
  const allowed: AdapterConfig["kind"][] = ["openai", "openai-responses", "anthropic", "openai-compatible"]
  if (!allowed.includes(rawKind as AdapterConfig["kind"])) {
    throw new Error(`invalid provider kind "${rawKind}" (expected openai | openai-responses | anthropic | openai-compatible)`)
  }
  const kind = rawKind as AdapterConfig["kind"]
  const baseUrl = args.baseUrl ?? process.env.NEWHORSE_BASE_URL ?? (kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com")
  const apiKey = kind === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY
  return { kind, baseUrl, apiKey }
}

/** Persist the event store here so a session survives a restart (goal #2). */
function resolveDataDir(args: Record<string, string>): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  const platform = process.platform === "win32" ? "newhorse" : ".config/newhorse"
  return args["data-dir"] ?? process.env.NEWHORSE_DATA_DIR ?? join(home, platform, "data")
}

/** Deterministic per-workspace session id so restart re-attaches to the log.
 * Users may pin one via --session / NEWHORSE_SESSION; otherwise undefined so
 * createApp derives a stable per-workspace id (the domain rule lives in core). */
function resolveSessionId(args: Record<string, string>): string | undefined {
  if (args.session) return args.session
  if (process.env.NEWHORSE_SESSION) return process.env.NEWHORSE_SESSION
  return undefined
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text.trim()
}

/** Ask the user a yes/no question on a TTY; a non-TTY (piped input) fails
 * closed (returns false) rather than hanging waiting for a human that never
 * answers. */
async function askUser(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(prompt, (a) => resolvePromise(a.trim()))
    })
    return answer === "y" || answer === "Y"
  } finally {
    rl.close()
  }
}

function printMessage(message: SessionMessage): void {
  if (message.kind === "user") {
    process.stdout.write(`\u001b[36m> \u001b[0m${message.text}\n`)
  } else if (message.kind === "assistant") {
    const text = message.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("")
    if (text) process.stdout.write(`\u001b[32m${text}\u001b[0m\n`)
  }
}

/** Interactive REPL: type a prompt, /steer <text>, /list, /interrupt, /quit.
 *  Ctrl-C cancels the CURRENT run (the next prompt starts fresh — a per-run
 *  AbortController inside app.prompt). */
async function repl(app: Awaited<ReturnType<typeof import("@newhorse/runtime").createApp>>): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("newhorse REPL — type a message, /help for commands. Ctrl-C interrupts the current run.")
  app.onEvent((event) => {
    if (event.type === "text") process.stdout.write(event.text)
    else if (event.type === "error") process.stderr.write(`\u001b[31m${event.message}\u001b[0m\n`)
    else if (event.type === "done") process.stdout.write(`\n`)
  })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = () => rl.question("> ", (line) => void handle(line))
  const handle = async (line: string): Promise<void> => {
    const text = line.trim()
    if (text === "/quit" || text === "/exit") { rl.close(); process.exit(0); return }
    if (text === "/help") { console.log("  /steer <text>  /list  /interrupt  /quit"); ask(); return }
    if (text === "/list") {
      console.log(JSON.stringify(await app.listSessions(), null, 2)); ask(); return
    }
    if (text === "/interrupt") { app.interrupt(); ask(); return }
    if (text.startsWith("/steer ")) { await app.steer(text.slice(7).trim()); ask(); return }
    if (!text) { ask(); return }
    // A slash command resolves against the plugin seam (never interpreted here).
    if (text.startsWith("/")) {
      const output = await app.runCommand(text)
      console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2))
      ask(); return
    }
    try {
      const result = await app.prompt(text, "user")
      console.log(`\u001b[2m(done: ${result.finish}, ${result.step} step(s))\u001b[0m`)
    } catch (e) {
      console.error(`\u001b[31m${e instanceof Error ? e.message : String(e)}\u001b[0m`)
    }
    ask()
  }
  ask()
}

/** `newhorse dag <spec.json>` — load a DAGSpec, run it, print node progress. */
async function runDagCli(file: string): Promise<void> {
  const { runDag, createBuiltinTools } = await import("@newhorse/runtime")
  const { MemoryEventStore, MemorySessionInput } = await import("@newhorse/core")
  const events = new MemoryEventStore()
  const inbox = new MemorySessionInput(events)
  const spec = (await import("node:fs/promises")).readFile(file, "utf8").then((s) => JSON.parse(s))
  const dagSpec = await spec as import("@newhorse/core").DAGSpec
  const workspace = process.cwd()
  const tools = createBuiltinTools({ workspace })
  // Provider for the DAG: env-first (same seams as the shell): NEWHORSE_PROVIDER
  // / NEWHORSE_BASE_URL / NEWHORSE_API_KEY, else the standard keys/defaults.
  const kind = (process.env.NEWHORSE_PROVIDER ?? "openai") as AdapterConfig["kind"]
  const baseUrl = process.env.NEWHORSE_BASE_URL ?? (kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com")
  const apiKey = process.env.NEWHORSE_API_KEY ?? (kind === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) ?? ""
  const provider: AdapterConfig = { kind, baseUrl, apiKey }
  const { makeLlmClient } = await import("@newhorse/llm")
  const runtime = { events, inbox, llm: makeLlmClient(provider) }
  const outcome = await runDag(dagSpec, { events, inbox, runtime, tools, workspace, defaultModel: process.env.NEWHORSE_MODEL ?? "gpt-4o-mini" })
  for (const [id, status] of Object.entries(outcome.status)) {
    console.log(`${status.padEnd(10)} ${id}${outcome.models[id] ? `  (${outcome.models[id]})` : ""}`)
  }
}
