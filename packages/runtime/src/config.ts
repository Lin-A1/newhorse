import { join } from "node:path"
import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { readFileSync } from "node:fs"

/**
 * Single authoritative configuration module (the runtime harness floor).
 *
 * Before this, CLI resolveProvider and server main.ts each read the same env
 * with slightly different fallbacks — a live drift. Everything env-driven is
 * defined HERE once; every consumer (CLI, server entrypoint, SDK embedding)
 * calls loadRuntimeSettings and gets the same strongly-typed result.
 *
 * Layers (high wins):
 *   defaults (this file) < agent-home config file (planned) < cli overrides < env
 *
 * Home directory: AGENT_RUNTIME_HOME (default ~/.newhorse). A HOST (e.g. the
 * newhorse desktop IDE) redirects it when embedding the runtime, so the
 * engine never reads a host-owned directory — the config equivalent of
 * "transport holds no domain logic".
 *
 * Workspace-level config is deliberately NOT here: the workspace is a
 * HOST-owned concern (the host reads its own per-workspace files and passes
 * the runtime segment via per-create sessionConfig). The security rule that
 * drove this: workspace files are writable by the model, so they must never
 * be able to upgrade execpolicy/provider — host-provided config only.
 */

export const ENV = {
  home: "AGENT_RUNTIME_HOME",
  provider: "NEWHORSE_PROVIDER",
  baseUrl: "NEWHORSE_BASE_URL",
  apiKey: "NEWHORSE_API_KEY",
  model: "NEWHORSE_MODEL",
  contextWindow: "NEWHORSE_CONTEXT_WINDOW",
  maxOutputTokens: "NEWHORSE_MAX_OUTPUT_TOKENS",
  dataDir: "NEWHORSE_DATA_DIR",
  port: "NEWHORSE_PORT",
  host: "NEWHORSE_HOST",
  token: "NEWHORSE_TOKEN",
  workspace: "NEWHORSE_WORKSPACE",
  allowBash: "NEWHORSE_ALLOW_BASH",
  allowPluginCode: "NEWHORSE_ALLOW_PLUGIN_CODE",
  memory: "NEWHORSE_MEMORY",
  memoryExtract: "NEWHORSE_MEMORY_EXTRACT",
  memoryVector: "NEWHORSE_MEMORY_VECTOR",
  memoryVectorMode: "NEWHORSE_MEMORY_VECTOR_MODE",
  embeddingKind: "NEWHORSE_EMBEDDING_KIND",
  embeddingModel: "NEWHORSE_EMBEDDING_MODEL",
  embeddingBaseUrl: "NEWHORSE_EMBEDDING_BASE_URL",
  embeddingApiKey: "NEWHORSE_EMBEDDING_API_KEY",
  approvalPolicy: "NEWHORSE_APPROVAL_POLICY",
  registry: "NEWHORSE_REGISTRY",
  advertiseUrl: "NEWHORSE_ADVERTISE_URL",
  uiDir: "NEWHORSE_UI_DIR",
  pluginsDir: "NEWHORSE_PLUGINS_DIR",
} as const

export type ProviderKind = "openai" | "openai-responses" | "anthropic" | "openai-compatible"

export interface ProviderSettings {
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly apiKey?: string
}

/**
 * A named provider preset (ccswitch semantics): one profile = one complete,
 * switchable configuration. Activating a profile makes IT the file-layer
 * provider — kind/baseUrl/apiKey/model/window all come from the profile at
 * once, so "上下文预算" and "模型与供应商" can never drift apart.
 */
export interface ProviderProfile {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly apiKey?: string
  readonly model?: string
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
}

export interface MemorySettings {
  readonly on: boolean
  readonly extraction: boolean
  readonly vector: {
    readonly enabled: boolean
    /** Index behind cosine: auto (vec0 extension, else in-memory) | brute | off (legacy per-query scan). */
    readonly mode: "auto" | "brute" | "off"
    readonly embedding: { readonly kind: "minimax" | "openai-compatible"; readonly baseUrl: string; readonly apiKey: string; readonly model: string }
  }
}

export interface RuntimeSettings {
  /** The engine's home directory (config/data/rules live under it). */
  readonly agentHome: string
  readonly dataDir: string
  readonly provider: ProviderSettings
  readonly model: string
  /** The model's context window in tokens — scales the auto-compaction
   *  trigger (a 32k-token model folds before it overflows, a 200k-token one
   *  does not summarize half-empty). Absent = the fixed 80k-char fallback. */
  readonly contextWindowTokens?: number
  /** Output budget per model reply (tokens) — without it the anthropic
   *  protocol silently truncates replies at a 4096-token floor. */
  readonly maxOutputTokens?: number
  readonly host: string
  readonly port: number
  readonly token?: string
  readonly workspace: string
  readonly allowBash: boolean
  readonly allowPluginCode: boolean
  /** Permission level: strict (floor + approval) | trusted (full access) | readonly (plan mode). */
  readonly approvalPolicy: "strict" | "trusted" | "readonly"
  readonly memory: MemorySettings
  /**
   * Cross-process session registry (M4): a shared SQLite file path. When set,
   * the server registers owned sessions there and proxies ops for sessions
   * owned by sibling processes. Unset → single-process routing only.
   */
  readonly registry?: string
  /** The active provider preset's id (ccswitch switch = one field write).
   *  Unset → the standalone `provider` above is the active configuration. */
  readonly activeProviderId?: string
  /** All provider presets stored in the agent-home config (server-side view
   *  with keys; the client gets a redacted projection via redactSettings). */
  readonly providers?: readonly ProviderProfile[]
  /** URL peers use to reach this server (default: derived from host:port). */
  readonly advertiseUrl?: string
  /** Directory of the built client UI served on this origin (web 单独启动). */
  readonly uiDir?: string
  /** Plugin/skills/agents directory (skills 浏览、角色发现、会话工具面). */
  readonly pluginsDir?: string
}

export interface ConfigLayers {
  /** Process env (L5 — highest). */
  readonly env: Record<string, string | undefined>
  /** Call-site overrides (CLI flags / host code) — above env. */
  readonly cli?: Partial<Pick<RuntimeSettings, "model" | "dataDir" | "port" | "token" | "workspace" | "allowBash" | "allowPluginCode" | "host" | "approvalPolicy" | "contextWindowTokens" | "maxOutputTokens">> & { readonly providerKind?: ProviderKind; readonly baseUrl?: string; readonly apiKey?: string }
  /** Home directory override (a host embedding the runtime redirects it). */
  readonly agentHome?: string
}

const DEFAULT_HOME = () => join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".newhorse")

/**
 * L2 — the agent-home CONFIG FILE (`~/.newhorse/config.json`). The persistent
 * settings layer a UI writes to (the desktop/web client's settings page):
 * defaults < **config file** < cli < env. JSON-shaped like a RuntimeSettings
 * subset; unknown keys are preserved on write (merge, never clobber), a
 * corrupt/missing file is an empty layer (never fails startup).
 */
export type AgentHomeConfig = Partial<Pick<RuntimeSettings, "provider" | "model" | "contextWindowTokens" | "maxOutputTokens" | "host" | "port" | "workspace" | "approvalPolicy" | "activeProviderId">> & {
  readonly memory?: { readonly on?: boolean; readonly extraction?: boolean; readonly vector?: { readonly enabled?: boolean; readonly mode?: "auto" | "brute" | "off" } }
  /** Upsert-merge of provider presets: items merge PER FIELD by `id`, so a
   *  client round-trip that omits `apiKey` keeps the stored key. */
  readonly providers?: readonly (Partial<Omit<ProviderProfile, "id">> & { readonly id: string })[]
  /** Preset ids to drop; clearing the active one also clears activeProviderId. */
  readonly providersRemove?: readonly string[]
}

export const configFilePath = (agentHome: string): string => join(agentHome, "config.json")

export async function readAgentHomeConfig(agentHome: string): Promise<AgentHomeConfig> {
  try {
    const raw = await readFile(configFilePath(agentHome), "utf8")
    const parsed = JSON.parse(raw) as AgentHomeConfig
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/** Sync variant for startup config resolution (loadRuntimeSettings is sync). */
function readAgentHomeConfigSync(agentHome: string): AgentHomeConfig {
  try {
    const parsed = JSON.parse(readFileSync(configFilePath(agentHome), "utf8")) as AgentHomeConfig
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/** Merge-write a settings patch into the config file (unknown keys preserved).
 *  `provider` merges PER FIELD — a client round-trip sends the redacted view
 *  (no apiKey), which must never wipe the stored key. `providers` upserts
 *  per id with the same per-field rule (an empty-string apiKey is treated as
 *  "keep stored", never a wipe); `providersRemove` drops ids (and the active
 *  pointer when it referenced a removed preset) but is never persisted itself.
 *  Writes are serialized (read-modify-write races) and atomic (tmp + rename —
 *  a crash mid-write must not leave a corrupt file that reads as "no keys"). */
const configWriteQueue: Promise<unknown> = Promise.resolve()

export function writeAgentHomeConfig(agentHome: string, patch: AgentHomeConfig): Promise<AgentHomeConfig> {
  const run = configWriteQueue.then(() => writeAgentHomeConfigInner(agentHome, patch))
  // keep the queue alive when a write fails — the NEXT write must still run
  void run.catch(() => {})
  return run
}

async function writeAgentHomeConfigInner(agentHome: string, patch: AgentHomeConfig): Promise<AgentHomeConfig> {
  const current = await readAgentHomeConfig(agentHome)
  const patchProvider = patch.provider as Record<string, unknown> | undefined
  const mergedProvider = patchProvider
    ? ({ ...(current.provider as Record<string, unknown> | undefined), ...patchProvider } as Record<string, unknown>)
    : (current.provider as Record<string, unknown> | undefined)
  if (mergedProvider) {
    delete mergedProvider.hasApiKey
    delete mergedProvider.apiKeyHint
  }
  // provider presets: upsert per field by id, then apply removals
  const stripDisplay = (p: Record<string, unknown>): Record<string, unknown> => {
    delete p.hasApiKey
    delete p.apiKeyHint
    return p
  }
  const byId = new Map<string, Record<string, unknown>>((current.providers ?? []).map((p) => [p.id, stripDisplay({ ...p })]))
  for (const item of patch.providers ?? []) {
    // An empty-string apiKey means "keep the stored key" (a client cannot know
    // it to resend it) — the server-side guard, not just client cooperation.
    const { apiKey: blankKey, ...rest } = item as Record<string, unknown>
    void blankKey
    const incoming = (item as Record<string, unknown>).apiKey === "" ? rest : (item as Record<string, unknown>)
    const prev = byId.get(item.id)
    byId.set(item.id, stripDisplay({ ...(prev ?? {}), ...incoming }))
  }
  const removed = new Set(patch.providersRemove ?? [])
  for (const id of removed) byId.delete(id)
  const providers = [...byId.values()] as unknown as Exclude<AgentHomeConfig["providers"], undefined>
  const activeRemoved = patch.activeProviderId === undefined && current.activeProviderId !== undefined && removed.has(current.activeProviderId)
  // providersRemove is a write-instruction, not state — never persist it; an
  // empty preset list is also dropped (absent = no presets, like a fresh file).
  // "" for activeProviderId means deactivate: clear the pointer, store nothing.
  const { providersRemove: _drop, ...patchRest } = patch
  void _drop
  const clearedActive = patch.activeProviderId === ""
  const patchRestNoActive = clearedActive
    ? Object.fromEntries(Object.entries(patchRest).filter(([k]) => k !== "activeProviderId"))
    : patchRest
  // When the patch touches the preset set (upsert OR removal), the merged list
  // must WIN over `current.providers` — otherwise a removal keeps the old list.
  const touchesProviders = patch.providers !== undefined || removed.size > 0
  const next = {
    ...current,
    ...patchRestNoActive,
    ...(patchProvider ? { provider: mergedProvider as AgentHomeConfig["provider"] } : {}),
    ...(touchesProviders ? { providers } : {}),
    ...((activeRemoved || clearedActive) ? { activeProviderId: undefined } : {}),
    memory: patch.memory ? { ...current.memory, ...patch.memory } : current.memory,
  } as Record<string, unknown>
  delete next.providersRemove
  if (Array.isArray(next.providers) && next.providers.length === 0) delete next.providers
  if (next.activeProviderId === undefined || next.activeProviderId === "") delete next.activeProviderId
  await mkdir(agentHome, { recursive: true })
  // Atomic write: a crash mid-write leaves config.json.tmp, never a truncated
  // config.json that would silently read as "no stored keys".
  const tmpPath = configFilePath(agentHome) + ".tmp"
  await writeFile(tmpPath, JSON.stringify(next, null, 2) + "\n", "utf8")
  await rename(tmpPath, configFilePath(agentHome))
  return next as AgentHomeConfig
}

function str(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]
  return v === undefined || v === "" ? undefined : v
}

function flag(env: Record<string, string | undefined>, key: string): boolean {
  return env[key] === "on"
}

/** An upsert item: a full profile with every field optional except the id. */
export type ProviderProfilePatch = Partial<Omit<ProviderProfile, "id">> & { readonly id: string }

/** The preset activated by `activeProviderId`, if it still exists. */
function activeProfile(file: AgentHomeConfig): ProviderProfilePatch | undefined {
  return file.activeProviderId ? (file.providers ?? []).find((p) => p.id === file.activeProviderId) : undefined
}

/** Default provider settings per kind (baseUrl/apiKey env fallbacks). The
 *  agent-home config file supplies the same fields when env/cli are silent
 *  (the UI settings page writes the file; env stays the ops override). When an
 *  active preset exists it IS the file-layer provider (ccswitch semantics). */
function resolveProvider(env: Record<string, string | undefined>, file: AgentHomeConfig, cli?: ConfigLayers["cli"]): ProviderSettings {
  const profile = activeProfile(file)
  const kind = (cli?.providerKind ?? str(env, ENV.provider) ?? profile?.kind ?? file.provider?.kind ?? "openai") as ProviderKind
  const defaultBase = kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"
  const baseUrl = cli?.baseUrl ?? str(env, ENV.baseUrl) ?? profile?.baseUrl ?? file.provider?.baseUrl ?? defaultBase
  const apiKey = cli?.apiKey ?? str(env, ENV.apiKey) ?? (kind === "anthropic" ? str(env, "ANTHROPIC_API_KEY") : str(env, "OPENAI_API_KEY")) ?? profile?.apiKey ?? file.provider?.apiKey
  return { kind, baseUrl, ...(apiKey ? { apiKey } : {}) }
}

/** Load the runtime settings: defaults ← agent-home config file ← env ← cli
 *  (cli wins over env for call-site intent; env wins over the file as an ops
 *  override; the file is what a UI persists). */
export function loadRuntimeSettings(layers: ConfigLayers): RuntimeSettings {
  const env = layers.env
  const agentHome = layers.agentHome ?? str(env, ENV.home) ?? DEFAULT_HOME()
  const file = readAgentHomeConfigSync(agentHome)
  const profile = activeProfile(file)
  const provider = resolveProvider(env, file, layers.cli)
  // A preset carries its model + budgets, so activating one switches them all
  // together (the profile sits at the file layer: cli/env still override).
  const model = layers.cli?.model ?? str(env, ENV.model) ?? profile?.model ?? file.model ?? "gpt-4o-mini"
  const contextWindow = str(env, ENV.contextWindow)
  const contextWindowTokens = layers.cli?.contextWindowTokens ?? (contextWindow ? Number(contextWindow) : undefined) ?? (profile?.contextWindowTokens && profile.contextWindowTokens > 0 ? profile.contextWindowTokens : undefined) ?? (file.contextWindowTokens && file.contextWindowTokens > 0 ? file.contextWindowTokens : undefined)
  const maxOutput = str(env, ENV.maxOutputTokens)
  const maxOutputTokens = layers.cli?.maxOutputTokens ?? (maxOutput ? Number(maxOutput) : undefined) ?? (profile?.maxOutputTokens && profile.maxOutputTokens > 0 ? profile.maxOutputTokens : undefined) ?? (file.maxOutputTokens && file.maxOutputTokens > 0 ? file.maxOutputTokens : undefined)
  const dataDir = layers.cli?.dataDir ?? str(env, ENV.dataDir) ?? join(agentHome, "data")
  // Normalize partial file items into well-formed profiles (name/baseUrl get
  // honest defaults) so the effective settings always carry complete presets.
  const providers: ProviderProfile[] = (file.providers ?? []).flatMap((p) => {
    if (!p.id) return []
    const kind = (p.kind ?? "openai") as ProviderKind
    return [{
      id: p.id,
      name: p.name ?? p.id,
      kind,
      baseUrl: p.baseUrl ?? (kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"),
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.contextWindowTokens && p.contextWindowTokens > 0 ? { contextWindowTokens: p.contextWindowTokens } : {}),
      ...(p.maxOutputTokens && p.maxOutputTokens > 0 ? { maxOutputTokens: p.maxOutputTokens } : {}),
    }]
  })
  const memoryOn = flag(env, ENV.memory)
  const vectorOn = flag(env, ENV.memoryVector)
  const vector: MemorySettings["vector"] = {
    enabled: vectorOn,
    mode: (str(env, ENV.memoryVectorMode) ?? "auto") as "auto" | "brute" | "off",
    embedding: {
      kind: (str(env, ENV.embeddingKind) ?? "minimax") as "minimax" | "openai-compatible",
      baseUrl: str(env, ENV.embeddingBaseUrl) ?? "https://api.minimaxi.com",
      apiKey: str(env, ENV.embeddingApiKey) ?? str(env, ENV.apiKey) ?? "",
      model: str(env, ENV.embeddingModel) ?? "embo-01",
    },
  }
  return {
    agentHome,
    dataDir,
    provider,
    model,
    ...(contextWindowTokens && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0 ? { contextWindowTokens } : {}),
    ...(maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    host: layers.cli?.host ?? str(env, ENV.host) ?? file.host ?? "127.0.0.1",
    port: layers.cli?.port ?? Number(str(env, ENV.port) ?? file.port ?? 3927),
    ...(layers.cli?.token ?? str(env, ENV.token) ? { token: layers.cli?.token ?? str(env, ENV.token) } : {}),
    workspace: layers.cli?.workspace ?? str(env, ENV.workspace) ?? file.workspace ?? process.cwd(),
    allowBash: layers.cli?.allowBash ?? flag(env, ENV.allowBash),
    allowPluginCode: layers.cli?.allowPluginCode ?? flag(env, ENV.allowPluginCode),
    approvalPolicy: (layers.cli?.approvalPolicy ?? str(env, ENV.approvalPolicy) ?? file.approvalPolicy ?? "strict") as "strict" | "trusted" | "readonly",
    memory: {
      on: memoryOn || file.memory?.on === true,
      extraction: (memoryOn || file.memory?.on === true) && (flag(env, ENV.memoryExtract) || file.memory?.extraction === true),
      vector: {
        ...vector,
        enabled: vectorOn || file.memory?.vector?.enabled === true,
        mode: (str(env, ENV.memoryVectorMode) ?? file.memory?.vector?.mode ?? "auto") as "auto" | "brute" | "off",
      },
    },
    ...(str(env, ENV.registry) ? { registry: str(env, ENV.registry) } : {}),
    ...(file.activeProviderId ? { activeProviderId: file.activeProviderId } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    ...(str(env, ENV.advertiseUrl) ? { advertiseUrl: str(env, ENV.advertiseUrl) } : {}),
    ...(str(env, ENV.uiDir) ? { uiDir: str(env, ENV.uiDir) } : {}),
    ...(str(env, ENV.pluginsDir) ? { pluginsDir: str(env, ENV.pluginsDir) } : {}),
  }
}
