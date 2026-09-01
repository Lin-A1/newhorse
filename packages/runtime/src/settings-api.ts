import type { ProviderProfile, RuntimeSettings, AgentHomeConfig } from "./config"

/**
 * Settings controller — the server-facing contract for the client's settings
 * page. `get` returns the EFFECTIVE settings (defaults ← config file ← env ←
 * cli); `write` persists a patch into the agent-home config file and returns
 * the reloaded effective settings. Sessions already created keep their
 * captured provider/model — new sessions pick up changes.
 */
export interface SettingsController {
  readonly get: () => RuntimeSettings
  readonly write: (patch: AgentHomeConfig) => Promise<RuntimeSettings>
}

/** A client-safe provider preset: presence + hint, never the key itself. */
export type RedactedProfile = Omit<ProviderProfile, "apiKey"> & { readonly hasApiKey: boolean; readonly apiKeyHint?: string }

export interface RedactedSettings extends Omit<RuntimeSettings, "provider" | "token" | "registry" | "advertiseUrl" | "providers" | "memory" | "channels" | "mcpServers"> {
  /** Channel configs with the secret stripped (presence + hint only). */
  readonly channels?: readonly (Omit<import("./channel").ChannelConfig, "secret"> & { readonly hasSecret?: boolean })[]
  /** MCP server settings with env/headers stripped (presence only) — they
   *  routinely carry Authorization headers and API keys. */
  readonly mcpServers?: Record<string, Omit<import("./config").McpServerSettings, "env" | "headers"> & { readonly hasEnv?: boolean; readonly hasHeaders?: boolean }>
  provider: Omit<RuntimeSettings["provider"], "apiKey"> & { readonly hasApiKey: boolean; readonly apiKeyHint?: string }
  readonly hasToken: boolean
  readonly providers?: readonly RedactedProfile[]
  readonly memory: {
    on: boolean
    extraction: boolean
    vector: {
      enabled: boolean
      mode: "auto" | "brute" | "off"
      embedding: { kind: "minimax" | "openai-compatible"; baseUrl: string; model: string; apiKey: string; hasApiKey?: boolean; apiKeyHint?: string }
    }
  }
}

const redactProfile = (p: ProviderProfile): RedactedProfile => {
  const { apiKey, ...rest } = p
  void apiKey
  return { ...rest, hasApiKey: !!apiKey, ...(apiKey && apiKey.length > 8 ? { apiKeyHint: `…${apiKey.slice(-4)}` } : {}) }
}

/** Client-safe view: secrets are never returned, only presence + a hint. */
export function redactSettings(s: RuntimeSettings): RedactedSettings {
  const { apiKey, ...provider } = s.provider
  void apiKey
  const { token, registry, advertiseUrl, providers, channels, mcpServers, ...rest } = s
  void token
  void registry
  void advertiseUrl
  // The embedding endpoint key is a secret too — redact to presence + hint.
  const embedKey = s.memory.vector.embedding.apiKey
  const memory: RedactedSettings["memory"] = {
    ...s.memory,
    vector: {
      ...s.memory.vector,
      embedding: {
        ...s.memory.vector.embedding,
        apiKey: "",
        ...(embedKey ? { hasApiKey: true, ...(embedKey.length > 8 ? { apiKeyHint: `…${embedKey.slice(-4)}` } : {}) } : {}),
      },
    },
  }
  return {
    ...rest,
    memory,
    provider: { ...provider, hasApiKey: !!apiKey, ...(apiKey && apiKey.length > 8 ? { apiKeyHint: `…${apiKey.slice(-4)}` } : {}) },
    hasToken: !!s.token,
    ...(providers && providers.length > 0 ? { providers: providers.map(redactProfile) } : {}),
    ...(channels ? { channels: channels.map((c) => {
      const { secret, ...r } = c
      void secret
      return { ...r, ...(secret ? { hasSecret: true } : {}) }
    }) } : {}),
    ...(mcpServers ? { mcpServers: Object.fromEntries(Object.entries(mcpServers).map(([k, v]) => {
      const { env, headers, ...r } = v
      void env
      void headers
      return [k, { ...r, ...(env ? { hasEnv: true } : {}), ...(headers ? { hasHeaders: true } : {}) }]
    })) } : {}),
  }
}
