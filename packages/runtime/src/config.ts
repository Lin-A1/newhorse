import { join } from "node:path"

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
} as const

export type ProviderKind = "openai" | "openai-responses" | "anthropic" | "openai-compatible"

export interface ProviderSettings {
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly apiKey?: string
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
  /** URL peers use to reach this server (default: derived from host:port). */
  readonly advertiseUrl?: string
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

function str(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]
  return v === undefined || v === "" ? undefined : v
}

function flag(env: Record<string, string | undefined>, key: string): boolean {
  return env[key] === "on"
}

/** Default provider settings per kind (baseUrl/apiKey env fallbacks). */
function resolveProvider(env: Record<string, string | undefined>, cli?: ConfigLayers["cli"]): ProviderSettings {
  const kind = (cli?.providerKind ?? str(env, ENV.provider) ?? "openai") as ProviderKind
  const baseUrl = cli?.baseUrl ?? str(env, ENV.baseUrl) ?? (kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com")
  const apiKey = cli?.apiKey ?? str(env, ENV.apiKey) ?? (kind === "anthropic" ? str(env, "ANTHROPIC_API_KEY") : str(env, "OPENAI_API_KEY"))
  return { kind, baseUrl, ...(apiKey ? { apiKey } : {}) }
}

/** Load the runtime settings: defaults ← cli overrides ← env (env wins over defaults; cli wins over env for call-site intent). */
export function loadRuntimeSettings(layers: ConfigLayers): RuntimeSettings {
  const env = layers.env
  const agentHome = layers.agentHome ?? str(env, ENV.home) ?? DEFAULT_HOME()
  const provider = resolveProvider(env, layers.cli)
  const model = layers.cli?.model ?? str(env, ENV.model) ?? "gpt-4o-mini"
  const contextWindow = str(env, ENV.contextWindow)
  const contextWindowTokens = layers.cli?.contextWindowTokens ?? (contextWindow ? Number(contextWindow) : undefined)
  const maxOutput = str(env, ENV.maxOutputTokens)
  const maxOutputTokens = layers.cli?.maxOutputTokens ?? (maxOutput ? Number(maxOutput) : undefined)
  const dataDir = layers.cli?.dataDir ?? str(env, ENV.dataDir) ?? join(agentHome, "data")
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
    host: layers.cli?.host ?? str(env, ENV.host) ?? "127.0.0.1",
    port: layers.cli?.port ?? Number(str(env, ENV.port) ?? 3927),
    ...(layers.cli?.token ?? str(env, ENV.token) ? { token: layers.cli?.token ?? str(env, ENV.token) } : {}),
    workspace: layers.cli?.workspace ?? str(env, ENV.workspace) ?? process.cwd(),
    allowBash: layers.cli?.allowBash ?? flag(env, ENV.allowBash),
    allowPluginCode: layers.cli?.allowPluginCode ?? flag(env, ENV.allowPluginCode),
    approvalPolicy: (layers.cli?.approvalPolicy ?? str(env, ENV.approvalPolicy) ?? "strict") as "strict" | "trusted" | "readonly",
    memory: {
      on: memoryOn,
      extraction: memoryOn && flag(env, ENV.memoryExtract),
      vector,
    },
    ...(str(env, ENV.registry) ? { registry: str(env, ENV.registry) } : {}),
    ...(str(env, ENV.advertiseUrl) ? { advertiseUrl: str(env, ENV.advertiseUrl) } : {}),
  }
}
