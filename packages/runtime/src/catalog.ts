import { join } from "node:path"

/**
 * Model capability catalog (docs/agent-runtime-integrations.md §2). A data
 * file the host ships next to the agent home — providers with per-kind
 * endpoints and per-model capability metadata (context window, output budget,
 * modalities, reasoning levels). REFERENCE DATA ONLY: routing still reads
 * AgentHomeConfig; the catalog exists so a client's model-config UI can offer
 * "pick a model → budgets autofill" instead of hand-typed numbers.
 */

export interface CatalogEndpoints {
  readonly baseURL: string
  /** protocol kind → path suffix (e.g. { anthropic: "/anthropic/v1/messages" }). */
  readonly paths?: Record<string, string>
}

export interface CatalogModel {
  readonly id: string
  readonly name?: string
  /** Which protocol kinds this model speaks (e.g. ["anthropic", "openai-compatible"]). */
  readonly kinds?: readonly string[]
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] }
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
  /** Opaque reasoning-level map — passed through to the client untouched. */
  readonly reasoning?: unknown
}

export interface CatalogProvider {
  readonly id: string
  readonly name?: string
  readonly endpoints?: CatalogEndpoints
  readonly defaultKind?: string
  readonly models: readonly CatalogModel[]
}

export interface ModelCatalog {
  readonly schemaVersion: number
  readonly providers: readonly CatalogProvider[]
}

/** Minimum validation: providers is a non-empty list of entries with id+models.
 *  Anything deeper stays permissive — the catalog is advisory data, and an
 *  over-strict parser turns one malformed model row into a missing catalog. */
export function parseModelCatalog(raw: unknown): ModelCatalog | null {
  if (!raw || typeof raw !== "object") return null
  const root = raw as { schemaVersion?: unknown; providers?: unknown }
  if (!Array.isArray(root.providers) || root.providers.length === 0) return null
  const providers: CatalogProvider[] = []
  for (const p of root.providers) {
    if (!p || typeof p !== "object") continue
    const provider = p as Record<string, unknown>
    if (typeof provider.id !== "string" || provider.id === "") continue
    const models = Array.isArray(provider.models)
      ? provider.models.filter((m): m is CatalogModel => !!m && typeof m === "object" && typeof (m as CatalogModel).id === "string" && (m as CatalogModel).id !== "")
      : []
    providers.push({
      id: provider.id,
      ...(typeof provider.name === "string" ? { name: provider.name } : {}),
      ...(provider.endpoints && typeof provider.endpoints === "object" ? { endpoints: provider.endpoints as CatalogEndpoints } : {}),
      ...(typeof provider.defaultKind === "string" ? { defaultKind: provider.defaultKind } : {}),
      models,
    })
  }
  if (providers.length === 0) return null
  return { schemaVersion: typeof root.schemaVersion === "number" ? root.schemaVersion : 1, providers }
}

/**
 * Load `<agentHome>/model-catalog.json`. Fail-soft: a missing or malformed
 * file yields null (the model-config UI degrades to hand-filled numbers) and
 * the reason goes to stderr once, never thrown — a broken catalog must not
 * take down session creation.
 */
export async function loadModelCatalog(agentHome: string): Promise<ModelCatalog | null> {
  const file = Bun.file(join(agentHome, "model-catalog.json"))
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      console.error("[catalog] model-catalog.json is unreadable or invalid JSON — catalog disabled:", err instanceof Error ? err.message : err)
    }
    return null
  }
  const parsed = parseModelCatalog(raw)
  if (!parsed) console.error("[catalog] model-catalog.json has no usable providers — catalog disabled")
  return parsed
}

/** Look up one model row by provider + model id (ids are exact matches). */
export function findCatalogModel(catalog: ModelCatalog | null, providerId: string | undefined, modelId: string): CatalogModel | undefined {
  if (!catalog) return undefined
  const providers = providerId ? catalog.providers.filter((p) => p.id === providerId) : catalog.providers
  for (const p of providers) {
    const hit = p.models.find((m) => m.id === modelId)
    if (hit) return hit
  }
  return undefined
}
