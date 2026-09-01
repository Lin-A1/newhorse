/**
 * Typed client for the newhorse runtime server. Same-origin by default (the
 * server serves this UI); cross-origin dev uses VITE_API_URL, and the token
 * lives in localStorage (NEWHORSE_TOKEN) — set once in the settings page.
 */

import type { EffectiveSettingsView } from "./types"

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ""

function headers(jsonBody?: unknown): Record<string, string> {
  const h: Record<string, string> = {}
  const token = localStorage.getItem("NEWHORSE_TOKEN")
  if (token) h.authorization = `Bearer ${token}`
  if (jsonBody !== undefined) h["content-type"] = "application/json"
  return h
}

async function json<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(BASE + path, {
    method: opts?.method ?? (opts?.body !== undefined ? "POST" : "GET"),
    headers: headers(opts?.body),
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 200))
  return (await res.json()) as T
}

// --- sessions ---

export interface SessionRow { sessionId: string; workspace: string; title?: string; status: string; model?: string; parentId?: string; role?: "butler"; createdAt: number; updatedAt: number; archived?: boolean; tokensUsed?: number }
export interface ChatMessage { role: "user" | "assistant" | "system" | "tool"; content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; text2?: string }> }

/** One durable event row (the client folds it into a transcript). `seq` is
 *  the fork point for 回退重发. */
export interface StoredEventRow { aggregate?: string; seq: number; type: string; data: Record<string, unknown>; /** store-level write time (created_at); legacy rows may be undefined */ ts?: number }

export const api = {
  health: () => json<{ status: string }>("/v1/health"),
  createSession: (sessionId?: string, workspace?: string, asButler?: boolean) => json<{ sessionId: string; messageCount: number }>("/v1/session", { body: { ...(sessionId ? { sessionId } : {}), ...(workspace ? { workspace } : {}), ...(asButler ? { asButler: true } : {}) } }),
  sessions: (workspace?: string) => json<{ rows?: SessionRow[] } | SessionRow[]>("/v1/sessions" + (workspace ? `?workspace=${encodeURIComponent(workspace)}` : "")).then((r) => (Array.isArray(r) ? r : r.rows ?? [])) as Promise<SessionRow[]>,
  snapshot: (id: string) => json<{ id: string; messages?: Array<{ kind: string; text?: string; content?: unknown }>; headSeq: number }>(`/v1/session/${id}`),
  events: (id: string) => json<StoredEventRow[]>(`/v1/session/${id}/events`),
  interrupt: (id: string) => json<{ interrupted: boolean }>(`/v1/session/${id}/interrupt`, { body: {} }),
  steer: (id: string, text: string) => json<{ admitted: boolean }>(`/v1/session/${id}/steer`, { body: { text } }),

  // --- per-session permission level (分级 harness) ---
  policy: (id: string) => json<{ policy: "strict" | "readonly" | "trusted" }>(`/v1/session/${id}/policy`),
  setPolicy: (id: string, policy: "strict" | "readonly" | "trusted") => json<{ policy: string }>(`/v1/session/${id}/policy`, { body: { policy } }),

  // --- slash commands (plugin command seam) ---
  commands: () => json<{ commands: Array<{ name: string; description?: string }> }>("/v1/commands"),
  runCommand: (id: string, text: string) => json<{ output: unknown }>(`/v1/session/${id}/command`, { body: { text } }),

  /** Stream one prompt over SSE; onEvent receives each server event. Returns
   *  the final result payload. The stream ends with [DONE]. Images are raw
   *  base64 (no data: prefix) — the transport caps count and size. */
  prompt(id: string, text: string, onEvent: (e: Record<string, unknown>) => void, signal?: AbortSignal, images?: Array<{ mime: string; data: string }>): Promise<{ finish?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      fetch(BASE + `/v1/session/${id}/prompt`, { method: "POST", headers: headers({ text }), body: JSON.stringify({ text, ...(images?.length ? { images } : {}) }), signal })
        .then(async (res) => {
          if (!res.ok || !res.body) throw new Error(`${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          let result: { finish?: string; error?: string } = {}
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, idx)
              buffer = buffer.slice(idx + 2)
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue
                const payload = line.slice(6)
                if (payload === "[DONE]") {
                  resolve(result)
                  return
                }
                try {
                  const e = JSON.parse(payload) as Record<string, unknown>
                  onEvent(e)
                  if (e.type === "result") result = { finish: (e as { finish?: string }).finish }
                  if (e.type === "error") result = { error: String((e as { message?: string }).message ?? "error") }
                } catch {
                  // A malformed frame never kills the stream.
                }
              }
            }
          }
          resolve(result)
        })
        .catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
    })
  },

  // --- settings / models ---
  settings: () => json<EffectiveSettingsView>("/v1/settings"),
  putSettings: (patch: unknown) => json<EffectiveSettingsView>("/v1/settings", { method: "PUT", body: patch }),
  models: () => json<{ models: string[] }>("/v1/models"),

  // --- approvals ---
  approvals: () => json<{ approvals: Array<{ id: string; kind: string; target: string; createdAt: number }> }>("/v1/approvals"),
  approve: (id: string, allow: boolean) => json<{ settled: boolean }>(`/v1/approvals/${id}`, { body: { allow } }),

  // --- usage ---
  usage: (days = 30) => json<UsageSummary>(`/v1/usage?days=${days}`),

  // --- schedules ---
  schedules: () => json<{ schedules: Schedule[] }>("/v1/schedules"),
  addSchedule: (input: { sessionId: string; prompt: string; intervalMinutes?: number; dailyAt?: string; cron?: string; enabled?: boolean }) => json<Schedule>("/v1/schedules", { body: input }),
  updateSchedule: (id: string, patch: Partial<Schedule>) => json<Schedule>(`/v1/schedules/${id}`, { method: "PATCH", body: patch }),
  removeSchedule: (id: string) => json<{ removed: boolean }>(`/v1/schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) => json<{ triggered: boolean }>(`/v1/schedules/${id}/run`, { body: {} }),

  // --- goal / todos / context ---
  goal: (id: string) => json<{ goal: { objective: string; status: string; tokenBudget?: number; tokensUsed?: number } | null; tokensUsed: number }>(`/v1/session/${id}/goal`),
  setGoal: (id: string, objective: string, tokenBudget?: number) => json<{ objective: string }>(`/v1/session/${id}/goal`, { body: { objective, tokenBudget } }),
  todos: (id: string) => json<{ todos: Array<{ content: string; status: string }> }>(`/v1/session/${id}/todos`),
  context: (id: string) => json<{ chars: number; estTokens: number; windowTokens?: number; ratio?: number }>(`/v1/session/${id}/context`),

  // --- session management ---
  archiveSession: (id: string) => json<{ archived: boolean }>(`/v1/session/${id}/archive`, { body: { archived: true } }),
  unarchiveSession: (id: string) => json<{ archived: boolean }>(`/v1/session/${id}/archive`, { body: { archived: false } }),
  deleteSession: (id: string) => json<{ deleted: boolean }>(`/v1/session/${id}`, { method: "DELETE" }),
  forkSession: (id: string, atSeq?: number) => json<{ sessionId: string; forkedFrom: string }>(`/v1/session/${id}/fork`, { body: atSeq !== undefined ? { atSeq } : {} }),
  setTitle: (id: string, title: string) => json<{ title: string }>(`/v1/session/${id}/title`, { body: { title } }),
  fs: (workspace?: string, path?: string) => json<{ path: string; entries: Array<{ name: string; dir: boolean }> }>(`/v1/fs?${workspace ? `workspace=${encodeURIComponent(workspace)}&` : ""}${path ? `path=${encodeURIComponent(path)}` : ""}`),

  // --- capabilities ---
  skills: () => json<{ skills: Array<{ name: string; description?: string; path: string }> }>("/v1/skills"),
  skillBody: (name: string) => json<{ name: string; body: string }>(`/v1/skills?name=${encodeURIComponent(name)}`),
  agents: () => json<{ agents: Array<{ name: string; description?: string; model?: string; allowedTools?: string[]; role?: string }> }>("/v1/agents"),

  // --- memory ---
  memory: (q = "") => json<{ memories: MemoryRecord[] }>(`/v1/memory?q=${encodeURIComponent(q)}`),
  deleteMemory: (id: string) => json<{ removed: boolean }>(`/v1/memory/${id}`, { method: "DELETE" }),
}

export interface Schedule { id: string; sessionId: string; prompt: string; enabled: boolean; intervalMinutes?: number; dailyAt?: string; cron?: string; createdAt: number; lastRunAt?: number; lastResult?: "ok" | "error"; lastError?: string }
export interface MemoryRecord { id: string; content: string; type: string; priority: number; sessionId?: string; createdAt: number }

export interface UsageSummary {
  days: Array<{ day: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; cost: number; steps: number; byModel: Record<string, { inputTokens: number; outputTokens: number }> }>
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; cost: number; steps: number }
  sessions: number
  sessionRows: Array<{ sessionId: string; model?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; cost: number; steps: number; lastActivity: number }>
}

/** Make a raw/first-message title safe to show: strip markdown, collapse
 *  whitespace, clip. Registry titles can still be raw assistant markdown. */
export function prettyTitle(title: string | undefined, fallback: string, max = 26): string {
  if (!title) return fallback
  const clean = title
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`>~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return fallback
  return clean.length > max ? clean.slice(0, max) + "…" : clean
}

// --- file-change tracking (codex review-changes / opencode file-changes) ---

export interface FileChange {
  /** Workspace-relative path (as the tool addressed it). */
  path: string
  /** Last tool that touched the file. */
  tool: string
  /** How many times the file was written/edited this session. */
  touches: number
  added: number
  removed: number
  /** Synthesized unified-ish diff of the LAST change (line-based). */
  diff: Array<{ kind: "add" | "del" | "same"; text: string }>
}

/** A minimal line diff good enough for exact-replace edit semantics: trim the
 *  common prefix/suffix, then the middle is -old +new. Full LCS is overkill
 *  for write (all-add) and exact-replace (one hunk) tool shapes. */
function lineDiff(oldText: string, newText: string): FileChange["diff"] {
  const a = oldText.length ? oldText.replace(/\n$/, "").split("\n") : []
  const b = newText.length ? newText.replace(/\n$/, "").split("\n") : []
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const out: FileChange["diff"] = []
  for (let i = 0; i < pre; i++) out.push({ kind: "same", text: a[i] ?? "" })
  for (let i = pre; i < a.length - suf; i++) out.push({ kind: "del", text: a[i] ?? "" })
  for (let i = pre; i < b.length - suf; i++) out.push({ kind: "add", text: b[i] ?? "" })
  for (let i = a.length - suf; i < a.length; i++) out.push({ kind: "same", text: a[i] ?? "" })
  return out
}

/** Fold the tool surface into per-file change records (chronological, last
 *  change's diff kept). write = whole-file add; edit = old/new hunk. */
export function foldFileChanges(events: StoredEventRow[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const e of events) {
    if (e.type !== "Session.MessageAppended") continue
    const m = (e.data ?? {}).message as { kind?: string; content?: Array<{ type?: string; name?: string; input?: unknown }> } | undefined
    if (m?.kind !== "assistant" || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (part.type !== "tool-call") continue
      const name = part.name ?? ""
      if (!/^(write|edit|Write|Edit)$/.test(name)) continue
      const input = (part.input ?? {}) as { path?: string; file_path?: string; content?: string; old?: string; new?: string }
      const path = input.path ?? input.file_path
      if (!path) continue
      const prev = byPath.get(path)
      let diff: FileChange["diff"]
      if (/^write$/i.test(name) && typeof input.content === "string") {
        diff = lineDiff("", input.content)
      } else if (/^edit$/i.test(name)) {
        diff = lineDiff(typeof input.old === "string" ? input.old : "", typeof input.new === "string" ? input.new : "")
      } else {
        continue
      }
      const added = diff.filter((d) => d.kind === "add").length
      const removed = diff.filter((d) => d.kind === "del").length
      byPath.set(path, { path, tool: name.toLowerCase(), touches: (prev?.touches ?? 0) + 1, added, removed, diff })
    }
  }
  return [...byPath.values()]
}

/** Compact relative time for session lists: 刚刚 / N 分钟前 / HH:mm / 昨天 / M月D日 */
export function relativeTime(ts: number): string {
  if (!(ts > 1000)) return "—"
  const diff = Date.now() - ts
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return "昨天"
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** Fold the durable event log into a displayable transcript. User turns keep
 *  the `seq` of their Prompted event — the fork point for 回退重发 — and their
 *  image attachments for rendering. */
export function foldTranscript(events: StoredEventRow[]): Array<{ kind: "user" | "assistant" | "tool" | "thinking" | "todo" | "goal" | "note"; text: string; toolName?: string; model?: string; seq?: number; images?: Array<{ mime: string; data: string }>; note?: "memory"; ts?: number }> {
  type FoldRow = { kind: "user" | "assistant" | "tool" | "thinking" | "todo" | "goal" | "note"; text: string; toolName?: string; model?: string; isError?: boolean; seq?: number; images?: Array<{ mime: string; data: string }>; note?: "memory"; ts?: number }
  const out: FoldRow[] = []
  // tool-call rows awaiting their result message (results arrive in call order)
  const pendingToolRows: number[] = []
  let assistant = ""
  let assistantTs: number | undefined
  const flush = (): void => {
    if (assistant) {
      out.push({ kind: "assistant", text: assistant, ts: assistantTs })
      assistant = ""
      assistantTs = undefined
    }
  }
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === "Session.Prompted") {
      flush()
      const images = (d.images as Array<{ mime: string; data: string }> | undefined)?.filter((img) => img?.mime && img?.data)
      out.push({ kind: "user", text: String(d.prompt ?? ""), seq: e.seq, ts: e.ts, ...(images?.length ? { images } : {}) })
    } else if (e.type === "Session.MessageAppended") {
      const m = d.message as { kind?: string; text?: string; content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>; model?: string; output?: unknown } | undefined
      if (!m) continue
      if (m.kind === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text" && p.text) {
            assistant += p.text
            assistantTs = e.ts
          }
          if ((p.type === "thinking" || p.type === "reasoning") && p.text) {
            flush()
            out.push({ kind: "thinking", text: p.text })
          }
          if (p.type === "tool-call") {
            flush()
            out.push({ kind: "tool", toolName: p.name, text: JSON.stringify(p.input ?? {}).slice(0, 400) })
            pendingToolRows.push(out.length - 1)
          }
        }
      } else if (m.kind === "tool") {
        flush()
        // the runtime writes tool results as a flat `m.output` object (may be
        // missing/empty); some providers fold them as content blocks — handle both
        const raw =
          m.output !== undefined
            ? typeof m.output === "string"
              ? m.output
              : JSON.stringify(m.output, null, 2)
            : (m.content as Array<{ type?: string; text?: string }> | undefined)?.map((c) => c.text ?? "").join("\n")
        const resultText = (raw ?? "").slice(0, 4000)
        const payloadError = /[{[]\s*"error"\s*:/i.test(resultText.slice(0, 200)) || (m.output as { error?: unknown } | undefined)?.error !== undefined
        // attach the result to its call row (expand to see output); fall back to a standalone row
        const idx = pendingToolRows.shift()
        if (idx !== undefined && out[idx]?.kind === "tool") {
          out[idx]!.text = resultText
          if (payloadError) out[idx]!.isError = true
        } else out.push({ kind: "tool", text: resultText, ...(payloadError ? { isError: true } : {}) })
      }
    } else if (e.type === "Session.ToolSettled" || e.type === "Session.ToolEnded") {
      // results already folded via tool messages where present
    } else if (e.type === "Session.TodoUpdated") {
      flush()
      const todos = (d.todos as Array<{ content: string; status: string }>) ?? []
      out.push({ kind: "todo", text: todos.map((t) => `${t.status === "completed" ? "[done]" : t.status === "in_progress" ? "[now]" : "[ ]"} ${t.content}`).join("\n") })
    } else if (e.type === "Session.GoalUpdated") {
      flush()
      out.push({ kind: "goal", text: `${String(d.objective ?? "")}（${String(d.status ?? "")}）` })
    } else if (e.type === "Session.MemoryStored") {
      flush()
      out.push({ kind: "note", note: "memory", text: String(d.content ?? "") })
    } else if (e.type === "Session.Interrupted") {
      flush()
      out.push({ kind: "note", text: "已中断" })
    } else if (e.type === "Session.Compacted") {
      flush()
      out.push({ kind: "note", text: "上下文已压缩" })
    }
  }
  flush()
  return out
}
