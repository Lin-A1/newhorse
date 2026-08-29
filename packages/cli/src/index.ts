import { createApp } from "@newhorse/runtime"
import type { AdapterConfig } from "@newhorse/llm"
import type { SessionMessage, ApprovalRequest } from "@newhorse/schema"
import { createInterface } from "node:readline"
import { join } from "node:path"

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
  const config: AdapterConfig = resolveProvider(args)

  const app = await createApp({
    provider: config,
    model: args.model ?? "gpt-4o-mini",
    workspace: process.cwd(),
    sessionId: resolveSessionId(args),
    dataDir: resolveDataDir(args),
    asButler: args.butler ? true : false,
    // M4 execpolicy: the transport owns the interactive approve gate. A prompt-
    // level tool decision (command/path) is surfaced to the user as a y/n
    // question; declining (or a non-TTY) fails closed to deny.
    onApprove: async (req: ApprovalRequest): Promise<boolean> => {
      const label = req.kind === "command" ? "command" : "path write"
      return askUser(`\u001b[33m[execpolicy] ${label}: ${req.target}\u001b[0m allow? (y/N) `)
    },
  })

  const promptText = args.prompt ?? (await readStdin())
  if (!promptText) {
    console.error("usage: newhorse [--provider openai|openai-responses|anthropic] [--model NAME] [--prompt TEXT] [--butler] [--data-dir DIR] [--session ID]")
    return
  }

  // Render streamed model output live; then only print user prompts from history
  // (assistant text was already streamed — avoid double-printing it).
  app.onEvent((event) => {
    if (event.type === "text") process.stdout.write(event.text)
    else if (event.type === "reasoning") process.stdout.write(`\u001b[2m${event.text}\u001b[0m`)
    else if (event.type === "error") process.stderr.write(`\u001b[31m${event.message}\u001b[0m\n`)
  })
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
