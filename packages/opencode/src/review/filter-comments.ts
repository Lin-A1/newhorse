// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/agent.go (buildFilterCommentsJSON,
// parseFilterResponse) and internal/llmloop/compression.go
// (StripMarkdownFences) of the open-code-review project. The falsify-not-
// verify review filter asks an LLM which of the just-collected comments are
// provably wrong given only the diff, then drops them.

import type { ReviewComment } from "./types"

/**
 * stripMarkdownFences removes an enclosing ```…``` fence from model output.
 */
export function stripMarkdownFences(s: string): string {
  s = s.trim()
  if (s.startsWith("```")) {
    const nl = s.indexOf("\n")
    if (nl >= 0) {
      s = s.slice(nl + 1)
    } else {
      s = s.replace(/^```json/, "")
      s = s.replace(/^```/, "")
    }
  }
  s = s.trim()
  if (s.endsWith("```")) {
    s = s.replace(/```$/, "")
    s = s.trim()
  }
  return s
}

interface FilterCommentItem {
  id: string
  content: string
  existing_code?: string
}

/**
 * buildFilterCommentsJSON serializes comments into a JSON array with generated
 * IDs `c-0`, `c-1`, … keyed to the per-path order in the collector.
 */
export function buildFilterCommentsJSON(comments: ReviewComment[]): string {
  const items: FilterCommentItem[] = comments.map((cm, i) => ({
    id: `c-${i}`,
    content: cm.content,
    ...(cm.existingCode ? { existing_code: cm.existingCode } : {}),
  }))
  return JSON.stringify(items)
}

/**
 * parseFilterResponse extracts the set of 0-based comment indices from the LLM
 * filter response. Invalid IDs, out-of-range indices and non-JSON responses are
 * ignored (a non-JSON response returns undefined).
 */
export function parseFilterResponse(raw: string, total: number): Set<number> | undefined {
  const stripped = stripMarkdownFences(raw)
  let ids: unknown
  try {
    ids = JSON.parse(stripped)
  } catch {
    return undefined
  }
  if (!Array.isArray(ids)) return undefined

  const indices = new Set<number>()
  for (const id of ids) {
    if (typeof id !== "string") continue
    const m = /^c-(\d+)$/.exec(id)
    if (!m) continue
    const idx = Number(m[1])
    if (idx >= 0 && idx < total) indices.add(idx)
  }
  return indices
}
