import { createServer } from "./server"
import type { SessionCreateRequest } from "./server"
import { createApp, loadRuntimeSettings, createSqliteSessionDirectory, createApprovalHub, createScheduler, createDagRunner, writeAgentHomeConfig, type Schedule } from "@newhorse/runtime"
import { createMcpTools } from "@newhorse/mcp"
import { MemoryMemoryStore, SqliteMemoryStore, createEmbeddingProvider } from "@newhorse/memory"
import { join } from "node:path"

/**
 * Standalone runtime-server entrypoint: `bun run packages/server/src/main.ts`
 *
 * The whole runtime is configured by ENV (see ../config.ts ENV table) — no
 * code required to embed it. Every env read goes through the single
 * authoritative config module, so this entrypoint and the CLI never drift.
 * A HOST embedding the runtime redirects the engine home via AGENT_RUNTIME_HOME.
 *
 * Client wiring (three surfaces, one artifact): NEWHORSE_UI_DIR (or a packaged
 * `ui/` next to this file) serves the built web client on the same origin;
 * the settings page persists into the agent-home config file; the approval
 * hub parks engine gates for the client to settle; the scheduler drives
 * scheduled prompts (定时任务).
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

// Interactive approvals: the client polls GET /v1/approvals and settles via
// POST /v1/approvals/:id; unanswered requests auto-deny after 2 minutes.
const approvals = createApprovalHub()

// Scheduled prompts (定时任务): persisted under the data dir; delivery is the
// server's admitPrompt (wired after the server exists).
let admit: ((sessionId: string, prompt: string) => Promise<void>) | undefined
const schedules = createScheduler({
  file: join(settings.dataDir, "schedules.json"),
  fire: (s: Schedule) => (admit ? admit(s.sessionId, s.prompt) : Promise.reject(new Error("server not started"))),
})

// DAG orchestration (编排): durable runtime over the dataDir event store;
// provider/model resolve fresh per run so settings changes apply.
const dagRunner = createDagRunner({
  dataDir: settings.dataDir,
  getProvider: () => loadRuntimeSettings({ env: process.env }).provider,
  getDefaultModel: () => loadRuntimeSettings({ env: process.env }).model,
  getWorkspace: () => loadRuntimeSettings({ env: process.env }).workspace,
  enableBash: settings.allowBash,
  memoryStore: settings.memory.on ? memStore : undefined,
  skillsDir: settings.pluginsDir,
})

// MCP client seam (docs/agent-runtime-integrations.md §1): configured servers
// mount once at startup and their tools ride EVERY session via AppConfig.tools
// (additive to builtins/plugins; first same-name wins). Fail-soft per server.
const mcp = settings.mcpServers && Object.keys(settings.mcpServers).length > 0 ? await createMcpTools(settings.mcpServers) : undefined
if (mcp) console.log(`  mcp       : ${mcp.tools.length} tool(s) from ${Object.keys(settings.mcpServers ?? {}).length} server(s)`)

const handle = await createServer({
  host: settings.host,
  port: settings.port,
  token: settings.token,
  // NO static onApprove: the approval hub parks requests for the client and
  // auto-denies unanswered ones after its timeout — fail-closed with a window.
  approvals,
  schedules,
  dagRunner,
  ...(settings.pluginsDir ? { pluginsDir: settings.pluginsDir } : {}),
  agentHome: settings.agentHome,
  ...(settings.channels?.length ? { channels: settings.channels } : {}),
  ...(mcp?.tools.length ? { tools: mcp.tools } : {}),
  memory: settings.memory.on ? memStore : undefined,
  ...(settings.registry ? { directory, advertiseUrl: settings.advertiseUrl } : {}),
  ...(settings.uiDir ? { uiDir: settings.uiDir } : {}),
  settings: {
    get: () => loadRuntimeSettings({ env: process.env }),
    write: async (patch) => {
      await writeAgentHomeConfig(settings.agentHome, patch)
      return loadRuntimeSettings({ env: process.env })
    },
  },
  // Per-session config resolves FRESH settings at create time — otherwise a
  // settings-page change would never reach new sessions (the closure would
  // hold the startup snapshot forever).
  sessionConfig: (create: SessionCreateRequest) => {
  const fresh = loadRuntimeSettings({ env: process.env })
  return ({
    // Per-session provider override honored (a host may map workspaces to
    // different providers) — server-level settings are only the default.
    provider: create.provider ?? fresh.provider,
    model: create.model ?? fresh.model,
    asButler: create.asButler === true,
    contextWindowTokens: create.contextWindowTokens ?? fresh.contextWindowTokens,
    maxOutputTokens: create.maxOutputTokens ?? fresh.maxOutputTokens,
    workspace: create.workspace ?? fresh.workspace,
    dataDir: create.dataDir ?? fresh.dataDir,
    enableBash: fresh.allowBash,
    allowPluginCode: fresh.allowPluginCode,
    // Sessions must discover plugin tools/commands/agents too — the
    // server-level pluginsDir only powers the catalog endpoints; without
    // this the skill/command seams exist but no session can consume them.
    ...(fresh.pluginsDir ? { pluginsDir: fresh.pluginsDir } : {}),
    memoryStore: fresh.memory.on ? memStore : undefined,
    memoryExtract: fresh.memory.extraction ? { enabled: true } : undefined,
    ...(fresh.memory.vector.enabled
      ? {
          memoryVector: {
            enabled: true,
            embedding: { kind: fresh.memory.vector.embedding.kind, baseUrl: fresh.memory.vector.embedding.baseUrl, apiKey: fresh.memory.vector.embedding.apiKey, model: fresh.memory.vector.embedding.model },
          },
        }
      : {})
  })
  },
})

// Wire scheduled-prompt delivery to the server's admit path (the scheduler
// was created before the server; delivery now resolves).
admit = handle.admitPrompt

console.log(`newhorse runtime server`)
console.log(`  listening : ${handle.baseUrl}`)
console.log(`  home      : ${settings.agentHome}`)
console.log(`  provider  : ${settings.provider.kind} @ ${settings.provider.baseUrl} (${settings.model})`)
if (settings.contextWindowTokens) console.log(`  context   : ${settings.contextWindowTokens} tokens (compaction scales to the window)`)
if (settings.maxOutputTokens) console.log(`  max out   : ${settings.maxOutputTokens} tokens per reply`)
if (settings.uiDir) console.log(`  ui        : ${settings.uiDir} (served on this origin)`)
console.log(`  dataDir   : ${settings.dataDir}`)
console.log(`  memory    : ${settings.memory.on ? `on${settings.memory.vector.enabled ? " + semantic" : ""}${settings.memory.extraction ? " + extraction" : ""}` : "off"}`)
console.log(`  bash      : ${settings.allowBash ? "on" : "off"}  plugin code: ${settings.allowPluginCode ? "trusted" : "off"}`)
console.log(`  token     : ${settings.token ? "required" : "loopback-only"}`)

// MCP transports own child processes/sockets — close them on shutdown.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void (mcp?.dispose() ?? Promise.resolve()).finally(() => process.exit(0))
  })
}
void createApp
