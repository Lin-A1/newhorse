import { Session } from "../session/session"
import type { EventStore } from "../session/store"
import type { SessionMessage, StoredEvent } from "@newhorse/schema"

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
  /** Optional LLM summarizer: (folded head text) -> summary. When absent, a
   *  cheap LOCAL marker ("[previous context: N messages folded...]") is used.
   *  The seam keeps compaction provider-agnostic — the caller (runtime) injects
   *  the summary call; a broken summarizer fails back to the local marker. */
  readonly summarize?: (headText: string) => Promise<string>
}

/** Compaction: keep the newest `retain` messages, fold the older head into a
 *  compacted marker, and append the durable boundary. Returns the new head seq. */
export async function compactSession(events: EventStore, sessionId: string, opts: CompactOptions = {}): Promise<{ boundarySeq: number; summary: string }> {
  const retain = Math.max(2, opts.retain ?? 12)
  const stored = await events.read(sessionId)
  const messages: SessionMessage[] = []
  const messageSeqs: number[] = []
  for (const e of stored) {
    if (e.type === "Session.MessageAppended") {
      messages.push((e.data as { message?: SessionMessage }).message!)
      messageSeqs.push(e.seq)
    }
  }
  if (messages.length <= retain) {
    // Nothing to compact — no boundary to write (the session is already small).
    return { boundarySeq: stored.at(-1)?.seq ?? -1, summary: "" }
  }
  const headCount = messages.length - retain
  const head = messages.slice(0, headCount)
  const tail = messages.slice(headCount)
  // boundarySeq = the LAST seq of the folded head. A read-time projection that
  // honors the boundary drops every MessageAppended with seq <= boundarySeq
  // (the head is represented by the summary marker), keeping ONLY the tail.
  const boundarySeq = messageSeqs[headCount - 1]!  // Summary of the collapsed head: an LLM summary when injected (compact the
  // head text), else the cheap local marker (counts + first prompt gist).
  const headText = head.map((m) => (m.kind === "user" ? m.text : m.kind === "assistant" ? (m as { content?: { type?: string; text?: string }[] }).content?.filter((p) => p.type === "text").map((p) => p.text!).join("\n") ?? "" : "")).join("\n\n")
  let summary: string
  if (opts.summarize) {
    try {
      // Race the summarizer against a hard timeout: a hung LLM must not stall
      // the turn; on timeout/failure the cheap local marker stands in.
      const result = await Promise.race([
        // The loser of the race must never surface a late unhandled rejection
        // (a summarizer failing AFTER the timeout resolved would crash the
        // process) — swallow it: the local marker already stood in.
        opts.summarize(headText.slice(0, 30_000)).then((s) => `[previous context] ${s}`).catch(() => ""),
        new Promise<string>((r) => setTimeout(() => r(""), 10_000)),
      ])
      summary = result || localSummary(headCount, head)
    } catch {
      summary = localSummary(headCount, head)
    }
  } else {
    summary = localSummary(headCount, head)
  }
  // Append the compaction marker (a user-role message so it is a normal part of
  // history; the encoders map kind "compaction" → user, and the model sees it
  // as a context stub, never a fake assistant claim).
  const session = Session.replay(stored)
  const marker = session.projectMessage({ kind: "compaction", id: crypto.randomUUID(), seq: 0, text: summary })
  await events.append(sessionId, marker.type, marker.data as Record<string, unknown>)
  await events.append(sessionId, "Session.Compacted", { sessionId, boundarySeq, summary, retainedFrom: tail.length })
  return { boundarySeq, summary }
}

/**
 * Read-time projection honoring the LAST compaction boundary: drop every
 * MessageAppended at seq <= boundarySeq (that head is represented by the
 * summary marker), keep the tail. This is what actually bounds the next
 * request — the full log is still durable (append-only), the model just sees
 * the compacted view. A session with no boundary returns its messages as-is.
 */
/** Cheap local summary (no LLM): counts + the first user prompt's gist. */
function localSummary(headCount: number, head: SessionMessage[]): string {
  const userPrompt = head.find((m) => m.kind === "user")?.text ?? ""
  return `[previous context: ${headCount} messages folded; original request: ${userPrompt.slice(0, 120)}${userPrompt.length > 120 ? "…" : ""}]`
}

export function projectCompacted(stored: StoredEvent[]): { messages: SessionMessage[]; boundary: number } {
  const boundaryEvent = [...stored].reverse().find((e) => e.type === "Session.Compacted")
  const boundary = boundaryEvent ? Number((boundaryEvent.data as { boundarySeq?: number }).boundarySeq ?? -1) : -1
  const messages: SessionMessage[] = []
  // Fold like Session.replay (Prompted promotes a user message; MessageAppended
  // pushes its message) but SKIP the head at seq <= boundary when a boundary
  // exists. The head is represented by the summary marker message (appended
  // AFTER the boundary, so it survives).
  for (const e of stored) {
    if (boundary >= 0 && e.seq <= boundary) continue
    switch (e.type) {
      case "Session.MessageAppended":
        messages.push((e.data as { message?: SessionMessage }).message!)
        break
      case "Session.Prompted": {
        const d = e.data as { id?: string; prompt?: string }
        if (d.id && typeof d.prompt === "string") messages.push({ kind: "user", id: d.id, seq: e.seq, text: d.prompt })
        break
      }
      default:
        break
    }
  }
  return { messages, boundary }
}
