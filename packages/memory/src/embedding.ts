/**
 * EmbeddingProvider seam — turns text into a vector for semantic memory
 * search. A seam because provider wire shapes differ (OpenAI `input` vs
 * MiniMax `texts`, asymmetric query/db types); the store only ever sees
 * `number[]`.
 *
 * Fail-soft contract: an implementation returns null on any failure (network,
 * auth, bad shape) — the caller stores metadata-only (deferred embedding) and
 * search falls back to FTS. Embedding must never fail a write or a search.
 */

export interface EmbeddingProvider {
  /** Embed one text. Returns null on failure (fail-soft, never throws). */
  readonly embed: (text: string, purpose: "db" | "query") => Promise<number[] | null>
  readonly dimensions?: number
}

export interface OpenAIEmbeddingConfig {
  readonly kind: "openai-compatible"
  readonly baseUrl: string
  readonly apiKey?: string
  readonly model: string
  readonly dimensions?: number
}

export interface MiniMaxEmbeddingConfig {
  readonly kind: "minimax"
  readonly apiKey: string
  readonly model: string
}

export type EmbeddingConfig = OpenAIEmbeddingConfig | MiniMaxEmbeddingConfig

/** Build a provider from config (the default assembly; fetch is injectable). */
export function createEmbeddingProvider(config: EmbeddingConfig, fetch: typeof globalThis.fetch = globalThis.fetch): EmbeddingProvider {
  if (config.kind === "minimax") {
    return {
      async embed(text, purpose) {
        try {
          const res = await fetch("https://api.minimaxi.com/v1/embeddings", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify({ model: config.model, texts: [text], type: purpose }),
          })
          if (!res.ok) return null
          const body = (await res.json()) as { vectors?: number[][] }
          const v = body.vectors?.[0]
          return Array.isArray(v) && v.length > 0 ? v : null
        } catch {
          return null
        }
      },
    }
  }
  // openai-compatible (default): POST {model, input} -> data[].embedding.
  const url = config.baseUrl.replace(/\/$/, "") + "/embeddings"
  return {
    dimensions: config.dimensions,
    async embed(text) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify({ model: config.model, input: text }),
        })
        if (!res.ok) return null
        const body = (await res.json()) as { data?: { embedding?: number[] }[] }
        const v = body.data?.[0]?.embedding
        return Array.isArray(v) && v.length > 0 ? v : null
      } catch {
        return null
      }
    },
  }
}

/** Cosine similarity between two vectors (0 when either is empty/length-mismatched). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
