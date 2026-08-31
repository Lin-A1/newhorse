import type { Schedule } from "./api"

export interface EffectiveSettingsView {
  model: string
  provider: { kind: string; baseUrl: string; hasApiKey: boolean; apiKeyHint?: string }
  contextWindowTokens?: number
  maxOutputTokens?: number
  host: string
  port: number
  workspace: string
  approvalPolicy: string
  memory: { on: boolean; extraction: boolean; vector: { enabled: boolean; mode: string } }
  allowBash: boolean
  allowPluginCode: boolean
  hasToken: boolean
  agentHome: string
}

export type { Schedule }
