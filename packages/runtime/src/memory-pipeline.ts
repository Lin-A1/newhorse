import type { LlmClient } from "@newhorse/llm"
import type { LLMRequest, LLMEvent } from "@newhorse/schema"
import type { MemoryPipeline, ExtractedMemory, ResetAction, MemoryRecord } from "@newhorse/memory"

/**
 * Default memory extraction pipe (fills the seam `runMemoryExtraction` was
 * waiting for): two LLM calls over the injected client —
 *   1. extract — recent messages + existing candidates → JSON atoms;
 *   2. dedup — atoms + candidates → JSON {action, targetIds, merged...}.
 * Provider-agnostic (any LlmClient), fail-closed downstream (extract.ts
 * already swallows a broken pipe).
 */

const EXTRACT_PROMPT = `You extract durable facts from a conversation into atomic memories.
Given the recent messages and any existing memories, return ONLY a JSON array, each item:
{"content":"...","type":"persona|episodic|instruction|fact","priority":0-100,"sourceIds":["msgId..."]}
Extract only what is durable and useful later; skip noise. No prose, no markdown fences.`

const DEDUP_PROMPT = `You reconcile new memory atoms against existing memories.
Return ONLY a JSON array, one item per input atom, in order:
{"action":"store|update|merge|skip","targetIds":["existingId"],"mergedContent":"...","mergedType":"...","mergedPriority":0-100}
- store: keep as a new memory.
- update/merge: replace/merge into the target existing memory (give the merged content).
- skip: this atom duplicates an existing memory; do not store.
No prose, no markdown fences.`

/** Extract the first `[...]` JSON array from an LLM text response. */
function parseJsonArray(text: string): unknown[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Build the default memory pipeline over any LLM client. */
export function createDefaultMemoryPipeline(client: LlmClient, model: string): MemoryPipeline {
  const ask = async (system: string, user: string): Promise<unknown[]> => {
    const request: LLMRequest = {
      model, // the owner's selected model — never a placeholder like "auto"
      messages: [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: user }] },
      ],
    }
    const stream = await client.stream(request)
    let text = ""
    for await (const ev of stream) {
      if (ev.type === "text.delta") text += ev.text
    }
    return parseJsonArray(text)
  }

  return {
    async extractL1MemoNext({ messages, candidates }) {
      const user = `Recent messages:\n${messages.map((m) => `${m.role}: ${m.text.slice(0, 1500)}`).join("\n")}\n\nExisting memories:\n${candidates.map((c) => `- ${c.content}`).join("\n")}`
      const items = await ask(EXTRACT_PROMPT, user)
      return items
        .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
        .map((it): ExtractedMemory => ({
          content: String(it.content ?? ""),
          type: (["persona", "episodic", "instruction", "fact"] as const).includes(it.type as never) ? (it.type as ExtractedMemory["type"]) : "fact",
          priority: Number.isFinite(Number(it.priority)) ? Number(it.priority) : 50,
          sourceIds: Array.isArray(it.sourceIds) ? it.sourceIds.map(String) : undefined,
        }))
        .filter((m) => m.content.length > 0)
    },
    async dedupMemories({ extracted, candidates }) {
      const user = `New atoms:\n${extracted.map((a, i) => `${i}: ${a.content}`).join("\n")}\n\nExisting memories:\n${candidates.map((c) => `- ${c.id} :: ${c.content}`).join("\n")}`
      const items = await ask(DEDUP_PROMPT, user)
      return items
        .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
        .map((it): ResetAction => {
          const action = ["store", "update", "merge", "skip"].includes(String(it.action)) ? (it.action as ResetAction["action"]) : "store"
          return {
            action,
            targetIds: Array.isArray(it.targetIds) ? it.targetIds.map(String) : undefined,
            mergedContent: typeof it.mergedContent === "string" ? it.mergedContent : undefined,
            mergedType: ["persona", "episodic", "instruction", "fact"].includes(String(it.mergedType)) ? (it.mergedType as ResetAction["mergedType"]) : undefined,
            mergedPriority: Number.isFinite(Number(it.mergedPriority)) ? Number(it.mergedPriority) : undefined,
          }
        })
    },
  }
}

export type { ExtractedMemory, ResetAction, MemoryRecord }
