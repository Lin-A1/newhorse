import { createApp } from "@newhorse/runtime"
import type { AdapterConfig } from "@newhorse/llm"
import type { SessionMessage } from "@newhorse/schema"

/**
 * CLI entrypoint. Reads a single prompt from argv or stdin, runs one session,
 * and prints the visible history. Transport only — all domain logic lives in
 * the runtime/core layers.
 */
export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const config: AdapterConfig = resolveProvider(args)

  const app = await createApp({
    provider: config,
    model: args.model ?? "gpt-4o-mini",
    workspace: process.cwd(),
    asButler: args.butler ? true : false,
  })

  const promptText = args.prompt ?? (await readStdin())
  if (!promptText) {
    console.error("usage: newhorse [--provider openai|openai-responses|anthropic] [--model NAME] [--prompt TEXT] [--butler]")
    return
  }

  // Render streamed model output live, then print the finalized history.
  app.onEvent((event) => {
    if (event.type === "text") process.stdout.write(event.text)
    else if (event.type === "reasoning") process.stdout.write(`\u001b[2m${event.text}\u001b[0m`)
    else if (event.type === "error") process.stderr.write(`\u001b[31m${event.message}\u001b[0m\n`)
  })
  await app.prompt(promptText, "user")
  const history = await app.resume()
  for (const message of history.messages) {
    printMessage(message)
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text.trim()
}

function printMessage(message: SessionMessage): void {
  if (message.kind === "user") {
    process.stdout.write(`\u001b[36m> \u001b[0m${message.text}\n`)
  } else if (message.kind === "assistant") {
    const text = message.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("")
    if (text) process.stdout.write(`\u001b[32m${text}\u001b[0m\n`)
  }
}
