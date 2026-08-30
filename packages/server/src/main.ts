import { createServer } from "./server"
import type { SessionCreateRequest } from "./server"
import { createApp, loadRuntimeSettings, createSqliteSessionDirectory } from "@newhorse/runtime"
import { MemoryMemoryStore, SqliteMemoryStore, createEmbeddingProvider } from "@newhorse/memory"
import { join } from "node:path"

/**
 * Standalone runtime-server entrypoint: `bun run packages/server/src/main.ts`
 *
 * The whole runtime is configured by ENV (see ../config.ts ENV table) — no
 * code required to embed it. Every env read goes through the single
 * authoritative config module, so this entrypoint and the CLI never drift.
 * A HOST embedding the runtime redirects the engine home via AGENT_RUNTIME_HOME.
 */
const settings = loadRuntimeSettings({ env: process.env })

// Memory: a durable SQLite store per dataDir when memory is on; in-memory otherwise.
const memStore = settings.memory.on ? new SqliteMemoryStore(join(settings.dataDir, "memory.db")) : new MemoryMemoryStore()
// Semantic search (switchable): attach once; the settings carry the model tag.
// The vector index mode: auto (sqlite-vec when loadable, else in-memory scan).
if (settings.memory.vector.enabled) {
  const { backfill } = memStore.attachEmbedder(
    createEmbeddingProvider({ kind: "minimax", apiKey: settings.memory.vector.embedding.apiKey, model: settings.memory.vector.embedding.model }),
    settings.memory.vector.embedding.model,
    { vectorMode: settings.memory.vector.mode },
  )
  void backfill().catch(() => {})
}

// Cross-process SessionManager (M4): when NEWHORSE_REGISTRY points at a shared
// SQLite file, this server registers owned sessions there and proxies ops for
// sibling-owned sessions. Unset → single-process routing.
const directory = settings.registry ? createSqliteSessionDirectory(settings.registry) : undefined

const handle = await createServer({
  host: settings.host,
  port: settings.port,
  token: settings.token,
  onApprove: async () => false, // server is non-interactive: fail-closed (M4)
  ...(directory ? { directory, advertiseUrl: settings.advertiseUrl } : {}),
  sessionConfig: (create: SessionCreateRequest) => ({
    // Per-session provider override honored (a host may map workspaces to
    // different providers) — server-level settings are only the default.
    provider: create.provider ?? settings.provider,
    model: create.model ?? settings.model,
    contextWindowTokens: create.contextWindowTokens ?? settings.contextWindowTokens,
    maxOutputTokens: create.maxOutputTokens ?? settings.maxOutputTokens,
    workspace: create.workspace ?? settings.workspace,
    dataDir: create.dataDir ?? settings.dataDir,
    enableBash: settings.allowBash,
    allowPluginCode: settings.allowPluginCode,
    memoryStore: settings.memory.on ? memStore : undefined,
    memoryExtract: settings.memory.extraction ? { enabled: true } : undefined,
    ...(settings.memory.vector.enabled
      ? {
          memoryVector: {
            enabled: true,
            embedding: { kind: settings.memory.vector.embedding.kind, baseUrl: settings.memory.vector.embedding.baseUrl, apiKey: settings.memory.vector.embedding.apiKey, model: settings.memory.vector.embedding.model },
          },
        }
      : {}),
  }),
})

console.log(`newhorse runtime server`)
console.log(`  listening : ${handle.baseUrl}`)
console.log(`  home      : ${settings.agentHome}`)
console.log(`  provider  : ${settings.provider.kind} @ ${settings.provider.baseUrl} (${settings.model})`)
if (settings.contextWindowTokens) console.log(`  context   : ${settings.contextWindowTokens} tokens (compaction scales to the window)`)
console.log(`  dataDir   : ${settings.dataDir}`)
console.log(`  memory    : ${settings.memory.on ? `on${settings.memory.vector.enabled ? " + semantic" : ""}${settings.memory.extraction ? " + extraction" : ""}` : "off"}`)
console.log(`  bash      : ${settings.allowBash ? "on" : "off"}  plugin code: ${settings.allowPluginCode ? "trusted" : "off"}`)
console.log(`  token     : ${settings.token ? "required" : "loopback-only"}`)
void createApp
