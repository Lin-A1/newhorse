import type { MemoryEntry, MemoryRecord, MemoryStore } from "./memory"

/** Cheap content normalization for the dedup-fallback guard: lower-case,
 * trim, collapse whitespace. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Memory extraction pipeline (borrowed from TencentDB-Agent-Memory L1 and
 * mem0's additive pattern): the "write" side of memory is NOT the model
 * calling memory_write — it is a post-turn LLM extraction over the session's
 * recent messages, with existing memories in the prompt so the LLM decides
 * ADD / UPDATE / MERGE / SKIP (never blind duplicate-insert).
 *
 * Two LLM calls (TencentDB's shape):
 *   1. extractL1MemoNext(count) — given background + new messages, return atoms.
 *   2. dedupMemories — given new atoms + top-k recalled candidates, decide
 *      per-atom { store | update | merge | skip }.
 *
 * The LLM seam is injected (a `LlmClient`), so the pipeline is provider-
 * agnostic and testable with a stub.
 */

export interface ExtractedMemory {
  readonly content: string
  readonly type: "persona" | "episodic" | "instruction" | "fact"
  readonly priority: number
  readonly sourceIds?: readonly string[]
}

export interface ResetAction {
  readonly action: "store" | "update" | "merge" | "skip"
  readonly targetIds?: readonly string[]
  readonly mergedContent?: string
  readonly mergedType?: "persona" | "episodic" | "instruction" | "fact"
  readonly mergedPriority?: number
}

export interface MemoryPipeline {
  readonly extractL1MemoNext: (opts: { messages: readonly { role: string; text: string }[]; candidates: readonly MemoryRecord[] }) => Promise<ExtractedMemory[]>
  readonly dedupMemories: (opts: { extracted: readonly ExtractedMemory[]; candidates: readonly MemoryRecord[] }) => Promise<ResetAction[]>
}

/**
 * Run the pipeline: extract from recent messages, then apply the dedup
 * decisions to the store (update/merge replaces the target record). Returns
 * the newly-stored/updated records. Fail-closed: if extraction fails, the
 * pipeline is a no-op (memory is best-effort, never blocks the turn).
 */
export async function runMemoryExtraction(
  pipe: MemoryPipeline,
  store: MemoryStore,
  opts: { messages: readonly { role: string; text: string }[]; sessionId: string; agentId?: string; userId?: string; topK?: number },
): Promise<{ stored: MemoryRecord[]; decisions: ResetAction[] }> {
  const candidates = await store.search("", opts.topK ?? 5, { sessionId: opts.sessionId, agentId: opts.agentId, userId: opts.userId })
  let extracted: ExtractedMemory[]
  try {
    extracted = await pipe.extractL1MemoNext({ messages: opts.messages, candidates })
  } catch {
    return { stored: [], decisions: [] } // best-effort: a broken LLM never fails the turn
  }
  if (extracted.length === 0) return { stored: [], decisions: [] }

  let decisions: ResetAction[]
  try {
    // Enrich the dedup candidate pool with per-atom keyword hits (the global
    // top-5 by priority is a weak similarity proxy; probing the atom's own
    // content surfaces the true duplicates a dedup LLM should see).
    const enriched: MemoryRecord[] = [...candidates]
    const seen = new Set(candidates.map((c) => c.id))
    for (const atom of extracted) {
      const probe = await store.search(atom.content, 3, { sessionId: opts.sessionId, agentId: opts.agentId, userId: opts.userId })
      for (const p of probe) {
        if (!seen.has(p.id)) { seen.add(p.id); enriched.push(p) }
      }
    }
    decisions = await pipe.dedupMemories({ extracted, candidates: enriched })
  } catch {
    // Fallback (TencentDB l1-extractor.ts:334): storage continues on dedup
    // failure — but a candidate with NORMALIZED-identical content is skipped so
    // a repeated fact is never duplicated (the cheap guard the LLM would have
    // done).
    const existing = new Set(candidates.map((c) => normalize(c.content)))
    decisions = extracted.map((atom) => ({ action: existing.has(normalize(atom.content)) ? ("skip" as const) : ("store" as const) }))
  }

  const stored: MemoryRecord[] = []
  const targetById = new Map(candidates.map((c) => [c.id, c]))
  for (let i = 0; i < extracted.length; i++) {
    const atom = extracted[i]!
    const decision = decisions[i] ?? { action: "store" as const }
    switch (decision.action) {
      case "skip":
        break
      case "store": {
        const rec = await store.write({
          content: atom.content,
          type: atom.type,
          priority: atom.priority,
          sessionId: opts.sessionId,
          agentId: opts.agentId,
          userId: opts.userId,
          sourceIds: atom.sourceIds,
        })
        stored.push(rec)
        break
      }
      case "update":
      case "merge": {
        const target = decision.targetIds?.map((id) => targetById.get(id)).find(Boolean)
        if (!target) break
        const rec = await store.write({
          content: decision.mergedContent ?? atom.content,
          type: decision.mergedType ?? target.type,
          priority: decision.mergedPriority ?? Math.max(target.priority, atom.priority),
          sessionId: opts.sessionId,
          agentId: opts.agentId,
          userId: opts.userId,
          sourceIds: atom.sourceIds,
        })
        stored.push(rec)
        break
      }
    }
  }
  return { stored, decisions }
}
