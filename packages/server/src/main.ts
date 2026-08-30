import { createServer } from "./server"
import type { SessionCreateRequest } from "./server"
import { MemoryMemoryStore, SqliteMemoryStore, createEmbeddingProvider, type EmbeddingConfig } from "@newhorse/memory"
import { join } from "node:path"

/**
 * Standalone runtime-server entrypoint: `bun run packages/server/src/main.ts`
 *
 * The whole runtime is configured by ENV — no code required to embed it:
 *   NEWHORSE_PROVIDER   openai | openai-responses | anthropic | openai-compatible (default openai)
 *   NEWHORSE_BASE_URL   provider base URL (default per provider)
 *   NEWHORSE_API_KEY    provider API key
 *   NEWHORSE_MODEL      model id (default gpt-4o-mini)
 *   NEWHORSE_DATA_DIR   durable event-store location (default ~/.newhorse-runtime/data)
 *   NEWHORSE_PORT       server port (default 3927)
 *   NEWHORSE_TOKEN      bearer token (absent = loopback-only)
 *   NEWHORSE_WORKSPACE  default workspace for new sessions (default cwd)
 *   NEWHORSE_ALLOW_BASH expose the bash tool (default off)
 *   NEWHORSE_MEMORY     "on" -> durable SQLite memory + memory tools
 *   NEWHORSE_MEMORY_EXTRACT  "on" -> post-turn LLM extraction into memory
 *   NEWHORSE_MEMORY_VECTOR   "on" -> semantic search (needs the embedding envs)
 *   NEWHORSE_EMBEDDING_KIND  minimax (default) | openai-compatible
 *   NEWHORSE_EMBEDDING_MODEL embo-01 | text-embedding-3-small | ...
 *   NEWHORSE_EMBEDDING_BASE_URL  embedding endpoint base
 *   NEWHORSE_EMBEDDING_API_KEY   embedding key (defaults to NEWHORSE_API_KEY)
 *   NEWHORSE_ALLOW_PLUGIN_CODE  "on" -> load .ts plugin tool definitions
 */

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === "" ? fallback : v
}

const kind = (env("NEWHORSE_PROVIDER", "openai") ?? "openai") as "openai" | "openai-responses" | "anthropic" | "openai-compatible"
const provider = {
  kind,
  baseUrl: env("NEWHORSE_BASE_URL") ?? (kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"),
  apiKey: env("NEWHORSE_API_KEY"),
}
const model = env("NEWHORSE_MODEL", "gpt-4o-mini")!
const dataDir = env("NEWHORSE_DATA_DIR") ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".newhorse-runtime", "data")
const workspace = env("NEWHORSE_WORKSPACE") ?? process.cwd()
const allowBash = env("NEWHORSE_ALLOW_BASH") === "on"
const allowPluginCode = env("NEWHORSE_ALLOW_PLUGIN_CODE") === "on"

// Memory: a durable SQLite store per dataDir when memory is on; in-memory otherwise.
const memoryOn = env("NEWHORSE_MEMORY") === "on"
const memStore = memoryOn ? new SqliteMemoryStore(join(dataDir, "memory.db")) : new MemoryMemoryStore()
// Semantic search (switchable): on only when explicitly enabled AND configured.
const vectorOn = env("NEWHORSE_MEMORY_VECTOR") === "on"
if (vectorOn) {
  const embedding: EmbeddingConfig = env("NEWHORSE_EMBEDDING_KIND") === "openai-compatible"
    ? { kind: "openai-compatible", baseUrl: env("NEWHORSE_EMBEDDING_BASE_URL") ?? "https://api.openai.com", apiKey: env("NEWHORSE_EMBEDDING_API_KEY") ?? env("NEWHORSE_API_KEY"), model: env("NEWHORSE_EMBEDDING_MODEL", "text-embedding-3-small")! }
    : { kind: "minimax", apiKey: env("NEWHORSE_EMBEDDING_API_KEY") ?? env("NEWHORSE_API_KEY") ?? "", model: env("NEWHORSE_EMBEDDING_MODEL", "embo-01")! }
  const { backfill } = memStore.attachEmbedder(createEmbeddingProvider(embedding), embedding.model)
  void backfill().catch(() => {})
}

const handle = await createServer({
  host: env("NEWHORSE_HOST", "127.0.0.1"),
  port: Number(env("NEWHORSE_PORT", "3927")),
  token: env("NEWHORSE_TOKEN"),
  onApprove: async () => false, // server is non-interactive: fail-closed (M4)
  sessionConfig: (create: SessionCreateRequest) => ({
    provider,
    model: create.model ?? model,
    workspace: create.workspace ?? workspace,
    dataDir: create.dataDir ?? dataDir,
    enableBash: allowBash,
    allowPluginCode,
    memoryStore: memoryOn ? memStore : undefined,
    memoryExtract: memoryOn && env("NEWHORSE_MEMORY_EXTRACT") === "on" ? { enabled: true } : undefined,
    ...(vectorOn ? { memoryVector: { enabled: true, embedding: { kind: (env("NEWHORSE_EMBEDDING_KIND") ?? "minimax") as "minimax" | "openai-compatible", baseUrl: env("NEWHORSE_EMBEDDING_BASE_URL") ?? "https://api.minimaxi.com", apiKey: env("NEWHORSE_EMBEDDING_API_KEY") ?? env("NEWHORSE_API_KEY") ?? "", model: env("NEWHORSE_EMBEDDING_MODEL", "embo-01")! } } } : {}),
  }),
  // Unused by createApp today but kept explicit: the approval gate is deny-all.
})

console.log(`newhorse runtime server`)
console.log(`  listening : ${handle.baseUrl}`)
console.log(`  provider  : ${provider.kind} @ ${provider.baseUrl} (${model})`)
console.log(`  dataDir   : ${dataDir}`)
console.log(`  memory    : ${memoryOn ? `on${vectorOn ? " + semantic" : ""}${env("NEWHORSE_MEMORY_EXTRACT") === "on" ? " + extraction" : ""}` : "off"}`)
console.log(`  bash      : ${allowBash ? "on" : "off"}  plugin code: ${allowPluginCode ? "trusted" : "off"}`)
console.log(`  token     : ${env("NEWHORSE_TOKEN") ? "required" : "loopback-only"}`)
