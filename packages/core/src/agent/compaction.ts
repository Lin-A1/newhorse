import { Session } from "../session/session"
import type { EventStore } from "../session/store"
import type { SessionMessage } from "@newhorse/schema"

/**
 * Local compaction (AGENTS.md goal #2 — long-horizon, no remote-only behavior;
 * codex's remote compaction is explicitly rejected).
 *
 * The first, honest version is a LOCAL fold, not an LLM summary: it preserves
 * the durable boundary (`Session.Compacted`), keeps the tail of the history
 * verbatim (most recent turns), and collapses the head into a single
 * `[previous context]` marker message so the next request stays well-formed
 * (context window bounded) without a remote summarization call. An LLM-summary
 * compaction (a second, richer boundary) can slot into the same seam later.
 *
 * Principle: "model-visible ⟺ logged" — the compacted boundary and the
 * collapsed message are durable events in the log; the model's view is the log
 * projection, never a fresh in-memory rewrite.
 */

export interface CompactOptions {
  /** Keep this many most-recent messages verbatim. Default 12. */
  readonly retain?: number
}

/** Compaction: keep the newest `retain` messages, fold the older head into a
 *  compacted marker, and append the durable boundary. Returns the new head seq. */
export async function compactSession(events: EventStore, sessionId: string, opts: CompactOptions = {}): Promise<{ boundarySeq: number; summary: string }> {
  const retain = Math.max(2, opts.retain ?? 12)
  const stored = await events.read(sessionId)
  const messages: SessionMessage[] = []
  for (const e of stored) {
    if (e.type === "Session.MessageAppended") messages.push((e.data as { message?: SessionMessage }).message!)
  }
  if (messages.length <= retain) {
    // Nothing to compact — no boundary to write (the session is already small).
    return { boundarySeq: stored.at(-1)?.seq ?? -1, summary: "" }
  }
  const head = messages.slice(0, messages.length - retain)
  const tail = messages.slice(messages.length - retain)
  const boundarySeq = stored.at(-1)!.seq
  // Local summary of the collapsed head: counts + the first user prompt's gist.
  const userPrompt = head.find((m) => m.kind === "user")?.text ?? ""
  const summary = `[previous context: ${head.length} messages folded; original request: ${userPrompt.slice(0, 120)}${userPrompt.length > 120 ? "…" : ""}]`
  // Append the compaction marker (a user-role message so it is a normal part of
  // history; the encoders map kind "compaction" → user, and the model sees it
  // as a context stub, never a fake assistant claim).
  const session = Session.replay(stored)
  const marker = session.projectMessage({ kind: "compaction", id: crypto.randomUUID(), seq: 0, text: summary })
  await events.append(sessionId, marker.type, marker.data as Record<string, unknown>)
  await events.append(sessionId, "Session.Compacted", { sessionId, boundarySeq, summary, retainedFrom: tail.length })
  return { boundarySeq, summary }
}
