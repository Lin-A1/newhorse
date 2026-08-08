import type { FSUtil } from "@newhorse/core/fs-util"
import { Global } from "@newhorse/core/global"
import path from "path"
import { Effect } from "effect"
import { Session } from "@/session/session"
import type { SessionV1 } from "@newhorse/core/v1/session"

const SNIPPET_LIMIT = 400
const MAX_ENTRIES_PER_SOURCE = 20
const MAX_FILES_PER_SOURCE = 200

export type DailyEntry = {
  source: "work" | "companion" | "claude" | "codex"
  title: string
  snippet: string
}

function truncate(text: string, limit = SNIPPET_LIMIT) {
  const t = text.trim().replace(/\s+/g, " ")
  return t.length > limit ? t.slice(0, limit) + "…" : t
}

export function dayStartMs(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function dayEndMs(date: Date) {
  return dayStartMs(new Date(date.getTime() + 86_400_000))
}

function within(ts: number, start: number, end: number) {
  return Number.isFinite(ts) && ts >= start && ts < end
}

/** Best-effort text extraction from a jsonl line (claude / codex shapes). */
function extractText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(extractText).join(" ").trim()
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>
    if (item.payload) return extractText(item.payload)
    if (item.message) return extractText(item.message)
    if (item.content) return extractText(item.content)
    if (item.text) return extractText(item.text)
  }
  return ""
}

function parseJsonlDay(text: string, start: number, end: number, isUser: (line: Record<string, unknown>) => boolean): string[] {
  const out: string[] = []
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue
    let line: Record<string, unknown>
    try {
      line = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    const ts = Date.parse(String(line.timestamp ?? line.time ?? ""))
    if (!within(ts, start, end)) continue
    if (!isUser(line)) continue
    const snippet = truncate(extractText(line))
    if (snippet) out.push(snippet)
  }
  return out
}

const isClaudeUser = (line: Record<string, unknown>) => {
  const message = line.message as Record<string, unknown> | undefined
  return message?.role === "user" || line.type === "user"
}

const isCodexUser = (line: Record<string, unknown>) => {
  const payload = line.payload as Record<string, unknown> | undefined
  const message = line.message as Record<string, unknown> | undefined
  return payload?.role === "user" || message?.role === "user"
}

/** Claude Code sessions under ~/.claude/projects (one jsonl per session). */
export function readClaudeCode(fs: FSUtil.Interface, start: number, end: number): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const files = yield* fs.glob(path.join(Global.Path.home, ".claude", "projects", "*", "*.jsonl"))
    const entries: string[] = []
    for (const file of files.slice(0, MAX_FILES_PER_SOURCE)) {
      const text = yield* fs.readFileStringSafe(file)
      if (!text) continue
      entries.push(...parseJsonlDay(text, start, end, isClaudeUser))
      if (entries.length >= MAX_ENTRIES_PER_SOURCE) break
    }
    return entries.slice(0, MAX_ENTRIES_PER_SOURCE)
  }).pipe(Effect.catch(() => Effect.succeed([])))
}

/** OpenAI Codex sessions under ~/.codex/sessions/YYYY/MM/DD. */
export function readCodex(fs: FSUtil.Interface, date: Date, start: number, end: number): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const y = String(date.getFullYear())
    const m = String(date.getMonth() + 1).padStart(2, "0")
    const d = String(date.getDate()).padStart(2, "0")
    const dir = path.join(Global.Path.home, ".codex", "sessions", y, m, d)
    const files = yield* fs.glob(path.join(dir, "*.jsonl"))
    const entries: string[] = []
    for (const file of files.slice(0, MAX_FILES_PER_SOURCE)) {
      const text = yield* fs.readFileStringSafe(file)
      if (!text) continue
      entries.push(...parseJsonlDay(text, start, end, isCodexUser))
      if (entries.length >= MAX_ENTRIES_PER_SOURCE) break
    }
    return entries.slice(0, MAX_ENTRIES_PER_SOURCE)
  }).pipe(Effect.catch(() => Effect.succeed([])))
}

function messageSnippet(messages: SessionV1.WithParts[]): string {
  for (const message of messages) {
    if (message.info.role !== "user") continue
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { text?: string }).text ?? "")
      .join(" ")
    if (text.trim()) return truncate(text)
  }
  return ""
}

/** newhorse work + companion sessions for the day, split by profile. */
export function readNewhorse(
  session: Session.Interface,
  start: number,
  end: number,
): Effect.Effect<DailyEntry[]> {
  return Effect.gen(function* () {
    const sessions = yield* session.listGlobal({ start, limit: 500 })
    const today = sessions.filter((s) => (s.time?.updated ?? 0) < end)
    const groups: Record<"work" | "companion", Session.GlobalInfo[]> = { work: [], companion: [] }
    for (const s of today) {
      groups[s.profileID === "companion" ? "companion" : "work"].push(s)
    }
    const out: DailyEntry[] = []
    for (const source of ["work", "companion"] as const) {
      for (const s of groups[source].slice(0, 10)) {
        const messages = yield* session.messages({ sessionID: s.id, limit: 20 })
        const snippet = messageSnippet(messages)
        if (!snippet) continue
        out.push({ source, title: s.title?.trim() || source, snippet })
      }
    }
    return out
  }).pipe(Effect.catch(() => Effect.succeed([])))
}
