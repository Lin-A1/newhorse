import type { ContentPart } from "./llm"

/**
 * Projected message in a session's visible history. A message is durable and
 * tracks which model produced it so model-relative lowering can degrade
 * reasoning when the continuation model changes.
 *
 * Message kinds mirror the durable session events; a MessageAppended event
 * projects one of these rows.
 */
export type SessionMessage =
  | { readonly kind: "user"; readonly id: string; readonly seq: number; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly seq: number; readonly content: ContentPart[]; readonly model?: string; readonly provider?: string }
  | { readonly kind: "tool"; readonly id: string; readonly seq: number; readonly callId: string; readonly name: string; readonly output: unknown; readonly isError?: boolean }
  | { readonly kind: "system"; readonly id: string; readonly seq: number; readonly text: string }
  | { readonly kind: "compaction"; readonly id: string; readonly seq: number; readonly text: string }
  // A memory recall/write record that is model-visible (e.g. what the model
  // was shown from the memory store). Kept separate from tool results so a
  // shell can render memory reads distinctly. Reserved seam (Phase 4).
  | { readonly kind: "memory"; readonly id: string; readonly seq: number; readonly text: string; readonly memoryIds?: readonly string[] }

export interface SessionSnapshot {
  readonly id: string
  readonly location: string
  readonly projectId?: string
  readonly createdAt: number
  readonly messages: SessionMessage[]
  /** Last durable seq in the log, used to recompute context baselines. */
  readonly headSeq: number
}
