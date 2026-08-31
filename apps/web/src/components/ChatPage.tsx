import { useCallback, useEffect, useRef, useState } from "react"
import { api, foldTranscript, type SessionRow } from "../api"
import { EmotionBall, type Mood } from "./EmotionBall"
import { Markdown } from "./Markdown"
import { IconSend, IconStop, IconTool, IconCheck, IconSpinner, IconCircle, IconTarget, IconBrain, IconNote, IconPlus, IconChevron } from "./icons"

export interface Turn {
  kind: "user" | "assistant" | "tool" | "todo" | "goal" | "note"
  text: string
  toolName?: string
}

const CURRENT_KEY = "NEWHORSE_CURRENT_SESSION"
const SUGGESTIONS = ["读取当前仓库结构并总结", "帮我写一个周报草稿", "检查最近改动的代码质量", "给这个项目写一份 README"]

/** Expandable tool-call chip (beautifului-style: quiet row, rich reveal). */
function ToolChip({ name, body }: { name?: string; body: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/25 overflow-hidden">
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors" onClick={() => setOpen(!open)}>
        <IconTool size={13} className="text-slate-500 shrink-0" />
        <span className="text-[12px] font-medium text-slate-300">{name ?? "tool"}</span>
        <span className="text-[11px] text-slate-600 truncate flex-1">{body.split("\n")[0]?.slice(0, 60)}</span>
        <IconChevron size={13} className={`text-slate-600 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <pre className="px-3.5 pb-3 pt-1 text-[11px] leading-relaxed text-slate-400 font-mono overflow-x-auto whitespace-pre-wrap break-all border-t border-white/[0.05]">{body}</pre>}
    </div>
  )
}

function TodoCard({ text }: { text: string }) {
  const lines = text.split("\n")
  return (
    <div className="rounded-xl border border-amber-300/[0.14] bg-amber-400/[0.05] px-3.5 py-3 space-y-1.5">
      {lines.map((l, i) => {
        const done = l.startsWith("[done]")
        const now = l.startsWith("[now]")
        const content = l.replace(/^\[(done|now|\s)\]\s*/, "")
        return (
          <div key={i} className="flex items-center gap-2 text-[13px]">
            {done ? <IconCheck size={13} className="text-emerald-400" /> : now ? <IconSpinner size={13} className="text-amber-300" /> : <IconCircle size={13} className="text-slate-600" />}
            <span className={done ? "text-slate-500 line-through" : now ? "text-amber-100" : "text-slate-400"}>{content}</span>
          </div>
        )
      })}
    </div>
  )
}

function TurnView({ t, index, openTools, setOpenTools, mood }: { t: Turn; index: number; openTools: Set<number>; setOpenTools: (f: (prev: Set<number>) => Set<number>) => void; mood: Mood }) {
  const isOpen = openTools.has(index)
  return (
    <div className={`flex gap-3 rise ${t.kind === "user" ? "justify-end" : "justify-start"}`}>
      {t.kind !== "user" && (
        <div className="mt-0.5 shrink-0 w-7">
          {t.kind === "tool" ? (
            <div className="h-7 w-7 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center">
              <IconTool size={13} className="text-slate-500" />
            </div>
          ) : t.kind === "todo" || t.kind === "goal" ? (
            <div className="h-7 w-7 rounded-lg bg-amber-400/[0.08] border border-amber-300/[0.14] flex items-center justify-center">
              <IconTarget size={13} className="text-amber-300" />
            </div>
          ) : t.kind === "note" ? (
            <div className="h-7 w-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
              <IconBrain size={13} className="text-slate-500" />
            </div>
          ) : (
            <EmotionBall mood={mood} size={28} />
          )}
        </div>
      )}
      <div className={`min-w-0 ${t.kind === "user" ? "max-w-[80%] md:max-w-[68%]" : "flex-1 max-w-[88%] md:max-w-[78%]"}`}>
        {t.kind === "tool" ? (
          <div className="rounded-xl border border-white/[0.07] bg-black/25 overflow-hidden">
            <button className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors" onClick={() => setOpenTools((prev) => { const n = new Set(prev); n.has(index) ? n.delete(index) : n.add(index); return n })}>
              <IconTool size={12} className="text-slate-500 shrink-0" />
              <span className="text-[12px] font-medium text-slate-300 shrink-0">{t.toolName ?? "tool"}</span>
              {!isOpen && <span className="text-[11px] text-slate-600 truncate flex-1">{t.text.split("\n")[0]?.slice(0, 70)}</span>}
              <IconChevron size={12} className={`text-slate-600 transition-transform ml-auto ${isOpen ? "rotate-90" : ""}`} />
            </button>
            {isOpen && <pre className="px-3.5 pb-3 pt-2 text-[11px] leading-relaxed text-slate-400 font-mono overflow-x-auto whitespace-pre-wrap break-all border-t border-white/[0.05]">{t.text}</pre>}
          </div>
        ) : t.kind === "todo" ? (
          <TodoCard text={t.text} />
        ) : t.kind === "goal" ? (
          <div className="rounded-xl border border-amber-300/[0.16] bg-amber-400/[0.07] px-3.5 py-2.5 flex items-center gap-2.5">
            <IconTarget size={14} className="text-amber-300 shrink-0" />
            <span className="text-[13px] text-amber-100">{t.text}</span>
          </div>
        ) : t.kind === "note" ? (
          <div className="inline-flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-1.5">
            <IconNote size={12} className="text-slate-500" />
            <span className="text-[11.5px] text-slate-500">{t.text}</span>
          </div>
        ) : t.kind === "user" ? (
          <div className="rounded-2xl rounded-tr-md bg-gradient-to-br from-accent/[0.22] to-accent-2/[0.10] border border-accent/[0.22] px-4 py-2.5 text-sm whitespace-pre-wrap break-words text-slate-100">{t.text}</div>
        ) : (
          <div className="rounded-2xl rounded-tl-md panel px-4 py-3 text-sm">
            <Markdown text={t.text} />
          </div>
        )}
      </div>
    </div>
  )
}

export function ChatPage({ onRunning }: { onRunning: (r: boolean) => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [current, setCurrent] = useState<string>(() => localStorage.getItem(CURRENT_KEY) ?? "")
  const [turns, setTurns] = useState<Turn[]>([])
  const [streaming, setStreaming] = useState("")
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState("")
  const [steerText, setSteerText] = useState("")
  const [error, setError] = useState("")
  const [openTools, setOpenTools] = useState<Set<number>>(new Set())
  const bottom = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback((): Promise<void> => api.sessions().then(setSessions).catch(() => {}), [])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    if (!current) {
      setTurns([])
      return
    }
    localStorage.setItem(CURRENT_KEY, current)
    api
      .events(current)
      .then((events) => setTurns(foldTranscript(events)))
      .catch(() => setTurns([]))
  }, [current])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [turns, streaming])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    setError("")
    setBusy(true)
    onRunning(true)
    let sessionId = current
    try {
      if (!sessionId) {
        const created = await api.createSession()
        sessionId = created.sessionId
        setCurrent(sessionId)
        localStorage.setItem(CURRENT_KEY, sessionId)
      }
      setTurns((t) => [...t, { kind: "user", text }])
      setInput("")
      const controller = new AbortController()
      window.__nhAbort = controller
      const result = await api.prompt(sessionId, text, (e) => {
        if (e.type === "text") setStreaming((s) => s + String((e as { text?: string }).text ?? ""))
      }, controller.signal)
      setStreaming("")
      if (result.error) setError(prettyError(result.error))
      const events = await api.events(sessionId)
      setTurns(foldTranscript(events))
      await refreshSessions()
    } catch (e) {
      setError(prettyError(e instanceof Error ? e.message : String(e)))
      setStreaming("")
    } finally {
      setBusy(false)
      onRunning(false)
    }
  }

  const interrupt = async (): Promise<void> => {
    if (!current) return
    window.__nhAbort?.abort()
    await api.interrupt(current).catch(() => {})
  }

  const steer = async (): Promise<void> => {
    if (!current || !steerText.trim()) return
    await api.steer(current, steerText.trim()).catch((e) => setError(prettyError(e instanceof Error ? e.message : String(e))))
    setSteerText("")
  }

  const goHome = (): void => {
    setCurrent("")
    setTurns([])
    localStorage.removeItem(CURRENT_KEY)
  }

  const currentRow = sessions.find((s) => s.sessionId === current)
  const mood: Mood = busy ? "thinking" : "idle"

  /* ── HOME: no session selected — the hero ─────────────────────── */
  if (!current) {
    const recent = sessions.slice(0, 6)
    return (
      <div className="h-full overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center px-4 py-10">
          <div className="w-full max-w-2xl flex flex-col items-center text-center gap-5 fade">
            <EmotionBall mood="idle" size={116} />
            <div>
              <h1 className="text-xl font-semibold text-slate-100 tracking-tight">有什么可以帮你？</h1>
              <p className="text-[13px] text-slate-500 mt-1">把任务交给管家，它会自己读文件、跑工具、记重点</p>
            </div>
            <div className="w-full panel-strong p-2.5 flex items-end gap-2">
              <textarea
                className="flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-slate-600"
                rows={2}
                placeholder="描述一个任务…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button className="btn-primary px-4 py-2 text-sm disabled:opacity-40" disabled={busy || !input.trim()} onClick={send}>
                <IconSend size={14} /> 发送
              </button>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((sg) => (
                <button key={sg} className="pill hover:!text-slate-200 hover:border-white/[0.14] transition-colors" onClick={() => setInput(sg)}>
                  {sg}
                </button>
              ))}
            </div>
          </div>

          {recent.length > 0 && (
            <div className="w-full max-w-2xl mt-12 fade">
              <div className="text-[11px] uppercase tracking-wider text-slate-600 mb-3 px-1">最近会话</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {recent.map((s) => (
                  <button
                    key={s.sessionId}
                    className="panel text-left p-3.5 hover:border-white/[0.14] hover:bg-white/[0.05] transition-all group"
                    onClick={() => {
                      setCurrent(s.sessionId)
                      localStorage.setItem(CURRENT_KEY, s.sessionId)
                    }}
                  >
                    <div className="text-[13px] text-slate-200 truncate group-hover:text-white">{s.title || s.sessionId.slice(0, 8)}</div>
                    <div className="text-[11px] text-slate-600 mt-1 flex items-center gap-1.5">
                      <span className={`inline-block h-1 w-1 rounded-full ${s.status === "active" ? "bg-emerald-400" : "bg-slate-600"}`} />
                      {s.updatedAt > 1000 ? new Date(s.updatedAt).toLocaleString() : "—"}
                      {s.model ? <span className="text-slate-700">·</span> : null}
                      {s.model && <span className="truncate">{s.model}</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  /* ── SESSION view ─────────────────────────────────────────────── */
  return (
    <div className="flex h-full">
      {/* Session rail */}
      <div className="hidden lg:flex flex-col w-64 shrink-0 border-r border-white/[0.06] bg-black/15">
        <div className="p-2.5">
          <button className="btn-ghost w-full py-1.5 text-[13px]" onClick={goHome}>
            <IconPlus size={13} /> 新会话
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-2 space-y-0.5">
          {sessions.map((s) => (
            <button key={s.sessionId} onClick={() => setCurrent(s.sessionId)} className={`w-full text-left px-2.5 py-2 rounded-lg text-[13px] transition-colors ${current === s.sessionId ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.04]"}`}>
              <div className="truncate">{s.title || s.sessionId.slice(0, 8)}</div>
              <div className="text-[10.5px] text-slate-600 mt-0.5">
                {s.updatedAt > 1000 ? new Date(s.updatedAt).toLocaleString() : "—"}{s.model ? ` · ${s.model}` : ""}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Session header */}
        <div className="flex items-center gap-3 px-4 md:px-6 py-2.5 border-b border-white/[0.06] bg-black/15">
          <button className="lg:hidden btn-ghost px-2 py-1 text-xs" onClick={goHome}>
            ←
          </button>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-slate-200 truncate">{currentRow?.title || current.slice(0, 8)}</div>
            {currentRow?.model && <div className="text-[11px] text-slate-600">{currentRow.model}</div>}
          </div>
          <div className="ml-auto pill">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${busy ? "bg-emerald-400 pulse-dot" : "bg-slate-600"}`} />
            {busy ? "运行中" : "就绪"}
          </div>
        </div>

        {/* Stream */}
        <div className="flex-1 overflow-y-auto px-3 md:px-6 py-5 space-y-3">
          {turns.map((t, i) => (
            <TurnView key={i} t={t} index={i} openTools={openTools} setOpenTools={setOpenTools} mood={mood} />
          ))}
          {streaming && (
            <div className="flex gap-3 justify-start">
              <div className="shrink-0 mt-0.5">
                <EmotionBall mood="speaking" size={28} />
              </div>
              <div className="rounded-2xl rounded-tl-md panel px-4 py-3 text-sm min-w-[80px]">
                <span className="caret">{streaming || " "}</span>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        {error && <div className="mx-4 mb-2 rounded-xl bg-red-500/[0.07] border border-red-500/25 text-red-300 text-xs px-3.5 py-2.5">{error}</div>}

        {/* Composer */}
        <div className="px-3 md:px-6 pb-4 pt-1">
          {busy && (
            <div className="flex gap-2 mb-2">
              <input className="input-base flex-1" placeholder="运行中… 插入追问（steer）" value={steerText} onChange={(e) => setSteerText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && steer()} />
              <button className="btn-ghost px-3 text-xs" onClick={steer}>
                插入
              </button>
              <button className="rounded-[14px] bg-red-500/15 border border-red-500/30 px-3 text-xs text-red-300 hover:bg-red-500/25 flex items-center gap-1.5" onClick={interrupt}>
                <IconStop size={12} /> 中断
              </button>
            </div>
          )}
          <div className="panel-strong flex items-end gap-2 p-2 !rounded-[22px]">
            <textarea
              className="flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-slate-600 max-h-40"
              rows={2}
              placeholder={busy ? "运行中…" : "输入任务…（Enter 发送，Shift+Enter 换行）"}
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button className="btn-primary px-3.5 py-2 text-sm shrink-0" disabled={busy || !input.trim()} onClick={send}>
              <IconSend size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function prettyError(raw: string): string {
  try {
    const m = raw.match(/\{.*\}/)
    if (m) {
      const d = JSON.parse(m[0]) as { error?: { message?: string }; message?: string }
      const msg = d.error?.message ?? d.message
      if (msg) return `${raw.split("{")[0].trim()}${msg}`
    }
  } catch {
    // fall through
  }
  return raw
}

declare global {
  interface Window {
    __nhAbort?: AbortController
  }
}
