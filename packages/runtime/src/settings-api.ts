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

export interface RedactedSettings extends Omit<RuntimeSettings, "provider" | "token" | "registry" | "advertiseUrl" | "providers"> {
  provider: Omit<RuntimeSettings["provider"], "apiKey"> & { readonly hasApiKey: boolean; readonly apiKeyHint?: string }
  readonly hasToken: boolean
  readonly providers?: readonly RedactedProfile[]
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
  const { token, registry, advertiseUrl, providers, ...rest } = s
  void token
  void registry
  void advertiseUrl
  return {
    ...rest,
    provider: { ...provider, hasApiKey: !!apiKey, ...(apiKey && apiKey.length > 8 ? { apiKeyHint: `…${apiKey.slice(-4)}` } : {}) },
    hasToken: !!s.token,
    ...(providers && providers.length > 0 ? { providers: providers.map(redactProfile) } : {}),
  }
}
