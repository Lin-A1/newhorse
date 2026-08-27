import { createApp } from "./app"
import type { AdapterConfig } from "@newhorse/llm"
import type { SessionMessage } from "@newhorse/schema"

/**
 * CLI entrypoint. Reads a single prompt from argv or stdin, runs one session,
 * and prints the visible history. Transport only — all domain logic lives in
 * the app/core layers.
 */
export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const config: AdapterConfig = resolveProvider(args)

  const app = await createApp({
    provider: config,
    model: args.model ?? "gpt-4o-mini",
    workspace: process.cwd(),
  })

  const promptText = args.prompt ?? (await readStdin())
  if (!promptText) {
    console.error("usage: newhorse [--provider openai|anthropic] [--model NAME] [--prompt TEXT]")
    return
  }

  await app.prompt(promptText)
  const history = await app.resume()
  for (const message of history.messages) {
    printMessage(message)
  }
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
  const allowed: AdapterConfig["kind"][] = ["openai", "anthropic", "openai-compatible"]
  if (!allowed.includes(rawKind as AdapterConfig["kind"])) {
    throw new Error(`invalid provider kind "${rawKind}" (expected openai | anthropic | openai-compatible)`)
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

if (import.meta.main) {
  await main(process.argv.slice(2))
}
