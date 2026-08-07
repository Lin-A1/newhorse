import type { Agent, Model as LegacyModel, ModelV2Info, Project, ProviderListResponse } from "@newhorse/sdk/v2/client"
import { NormalizedProviderListResponse } from "@newhorse/session-ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

export function adaptModelCatalog(input: ModelV2Info[]): LegacyModel[] {
  return input
    .filter((model) => model.enabled && model.status !== "deprecated")
    .map((model) => {
      const base = model.cost.find((cost) => !cost.tier) ?? model.cost[0]
      const tiers = model.cost.filter((cost) => cost.tier)
      return {
        id: model.id,
        providerID: model.providerID,
        api: {
          id: model.api.id,
          url: "url" in model.api ? model.api.url ?? "" : "",
          npm: "package" in model.api ? model.api.package : "",
        },
        name: model.name,
        family: model.family,
        capabilities: {
          temperature: false,
          reasoning: model.capabilities.input.includes("reasoning"),
          attachment: model.capabilities.input.some((kind) => kind !== "text"),
          toolcall: model.capabilities.tools,
          interleaved: false,
          input: {
            text: model.capabilities.input.includes("text"),
            audio: model.capabilities.input.includes("audio"),
            image: model.capabilities.input.includes("image"),
            video: model.capabilities.input.includes("video"),
            pdf: model.capabilities.input.includes("pdf"),
          },
          output: {
            text: model.capabilities.output.includes("text"),
            audio: model.capabilities.output.includes("audio"),
            image: model.capabilities.output.includes("image"),
            video: model.capabilities.output.includes("video"),
            pdf: model.capabilities.output.includes("pdf"),
          },
        },
        cost: {
          input: base?.input ?? 0,
          output: base?.output ?? 0,
          experimentalOver200K: undefined,
          cache: {
            read: base?.cache.read ?? 0,
            write: base?.cache.write ?? 0,
          },
          tiers: tiers.map((cost) => ({
            input: cost.input,
            output: cost.output,
            cache: cost.cache,
            tier: cost.tier!,
          })),
        },
        limit: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
        status: model.status,
        options: model.request.body,
        headers: model.request.headers,
        release_date: new Date(model.time.released).toISOString(),
        variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.body])),
      }
    })
}

export function legacyModelCatalog(input: NormalizedProviderListResponse): LegacyModel[] {
  return [...input.all.values()].flatMap((provider) => Object.values(provider.models))
}

export function filterModelCatalog(input: LegacyModel[], connected: Iterable<string>) {
  const ids = new Set(connected)
  return input.filter((model) => ids.has(model.providerID))
}

export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  return {
    ...input,
    all: new Map(
      input.all.map(
        (provider) =>
          [
            provider.id,
            {
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            },
          ] as const,
      ),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
