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
  /** Byte budget for the retained tail (the same JSON-chars measure the
   *  trigger uses). A COUNT-only retain makes no promise about tail size —
   *  one 50k-char file-read message twelve times over still overflows a
   *  small window. When the newest messages exceed this budget, the count
   *  cap shrinks so the overflow folds into the summarized head instead.
   *  Derived from the model window when known; default 30_000 chars. */
  readonly maxTailChars?: number
  /** Optional LLM summarizer: (folded head text) -> summary. When absent, a
   *  cheap LOCAL marker ("[previous context: N messages folded...]") is used.
   *  The seam keeps compaction provider-agnostic — the caller (runtime) injects
   *  the summary call; a broken summarizer fails back to the local marker. */
  readonly summarize?: (headText: string) => Promise<string>
  /** Cap on the head text handed to the summarizer (chars). Default 30_000 —
   *  scale it with the model window: a 200k-token model can summarize far
   *  more head than a 32k-token one. */
  readonly summarizeMaxChars?: number
  /** Hard timeout for the summarizer. Default scales with the prompt size
   *  (see summarizeTimeoutMs) — a fixed 10s silently degraded to the local
   *  marker exactly on the biggest (most summary-worthy) heads. */
  readonly summarizeTimeoutMs?: number
}

/** Summarizer timeout scaled to the prompt it must read: ~2.5k chars/s of
 *  provider throughput, floored at 10s (small heads still need model latency). */
export function summarizeTimeoutMs(promptChars: number): number {
  return Math.max(10_000, Math.ceil(promptChars / 2_500) * 1_000)
}

/** Compaction: keep the newest messages verbatim (count-capped by `retain`
 *  AND byte-capped by `maxTailChars` — whichever is tighter), fold everything
 *  older into a compacted marker, and append the durable boundary. Returns
 *  the new head seq. */
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
  // Effective keep: newest messages that fit BOTH the count cap and the byte
  // budget (always at least one — the newest exchange is the working context;
  // a single message larger than the whole budget still stays, documented).
  let keep = Math.min(retain, messages.length)
  if (opts.maxTailChars !== undefined) {
    let chars = 0
    let fit = 0
    for (let i = messages.length - 1; i >= 0 && fit < retain; i--) {
      const c = JSON.stringify(messages[i]!).length
      if (chars + c > opts.maxTailChars && fit > 0) break
      chars += c
      fit++
    }
    keep = Math.min(keep, Math.max(fit, 1))
  }
  const headCount = messages.length - keep
  if (headCount <= 0) {
    // Nothing to compact — no boundary to write (the session is already small).
    return { boundarySeq: stored.at(-1)?.seq ?? -1, summary: "" }
  }
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
      // the turn; on timeout/failure the cheap local marker stands in. The
      // timeout scales with the prompt actually sent — a fixed 10s degraded
      // to the local marker exactly on the biggest heads.
      const prompt = headText.slice(0, opts.summarizeMaxChars ?? 30_000)
      const result = await Promise.race([
        // The loser of the race must never surface a late unhandled rejection
        // (a summarizer failing AFTER the timeout resolved would crash the
        // process) — swallow it: the local marker already stood in.
        opts.summarize(prompt).then((s) => `[previous context] ${s}`).catch(() => ""),
        new Promise<string>((r) => setTimeout(() => r(""), opts.summarizeTimeoutMs ?? summarizeTimeoutMs(prompt.length))),
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
