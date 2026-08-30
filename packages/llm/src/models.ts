import type { AdapterConfig } from "./adapter"
import type { Fetcher } from "./route"

/**
 * Model listing for the client's quick-config UI: pull the provider's
 * available model ids so the user picks from a dropdown instead of typing a
 * model name blind. All protocols expose a `/v1/models` list — only the auth
 * header differs (the same Route mapping the chat path uses). Fail-soft: an
 * unreachable provider returns [] and the UI keeps manual entry.
 */
export async function listModels(config: AdapterConfig, fetch: Fetcher = globalThis.fetch): Promise<string[]> {
  const headers: Record<string, string> = config.kind === "anthropic"
    ? { "x-api-key": config.apiKey ?? "", "anthropic-version": "2023-06-01", ...(config.extraHeaders ?? {}) }
    : { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), ...(config.extraHeaders ?? {}) }
  try {
    const res = await fetch(config.baseUrl.replace(/\/$/, "") + "/v1/models", { headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0)
    return [...new Set(ids)].sort()
  } catch {
    return []
  }
}
