import { useCallback, useEffect, useRef, useState } from "react"
import { api, foldTranscript, type SessionRow } from "../api"
import { EmotionBall, type Mood } from "./EmotionBall"
import { IconSend, IconStop, IconTool, IconCheck, IconSpinner, IconCircle, IconTarget, IconNote, IconPlus } from "./icons"

interface Turn {
  kind: "user" | "assistant" | "tool" | "todo" | "goal" | "note"
  text: string
  toolName?: string
}

const CURRENT_KEY = "NEWHORSE_CURRENT_SESSION"
const SUGGESTIONS = ["读取当前仓库结构并总结", "帮我写一个周报草稿", "检查最近改动的代码质量"]

export function ChatPage({ onRunning }: { onRunning: (r: boolean) => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [current, setCurrent] = useState<string>(() => localStorage.getItem(CURRENT_KEY) ?? "")
  const [turns, setTurns] = useState<Turn[]>([])
  const [streaming, setStreaming] = useState("")
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState("")
  const [steerText, setSteerText] = useState("")
  const [error, setError] = useState("")
  const bottom = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback((): Promise<void> => api.sessions().then(setSessions).catch(() => {}), [])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  // Load the transcript of the selected session from the durable log.
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

  const mood: Mood = busy ? "thinking" : "idle"

  return (
    <div className="flex h-full">
      {/* Session list */}
      <div className="hidden lg:flex flex-col w-64 shrink-0 border-r border-white/[0.06] bg-black/15">
        <div className="px-3 py-3 text-[11px] uppercase tracking-wider text-slate-500 flex justify-between items-center">
          会话
          <button className="text-slate-400 hover:text-accent" title="新建会话" onClick={() => { setCurrent(""); setTurns([]) }}>
            <IconPlus size={15} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {sessions.map((s) => (
            <button key={s.sessionId} onClick={() => setCurrent(s.sessionId)} className={`w-full text-left px-3 py-2.5 text-sm border-l-2 transition-colors ${current === s.sessionId ? "border-accent bg-white/[0.05] text-white" : "border-transparent text-slate-400 hover:bg-white/[0.03]"}`}>
              <div className="truncate">{s.title || s.sessionId.slice(0, 8)}</div>
              <div className="text-[11px] text-slate-600 mt-0.5">
                {s.updatedAt > 1000 ? new Date(s.updatedAt).toLocaleString() : "—"}{s.model ? ` · ${s.model}` : ""}
              </div>
            </button>
          ))}
          {sessions.length === 0 && <div className="px-3 py-6 text-xs text-slate-600">还没有会话</div>}
        </div>
      </div>

      {/* Chat column */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto px-3 md:px-8 py-5 space-y-3.5">
          {turns.length === 0 && !streaming && (
            <div className="h-full flex flex-col items-center justify-center text-center gap-4">
              <EmotionBall mood="idle" size={96} />
              <div className="text-slate-400 text-sm">给管家一个任务吧</div>
              <div className="flex flex-wrap justify-center gap-2 max-w-md">
                {SUGGESTIONS.map((sg) => (
                  <button key={sg} className="nh-card px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.07] transition-colors" onClick={() => { setInput(sg) }}>
                    {sg}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`flex gap-2.5 nh-rise ${t.kind === "user" ? "justify-end" : "justify-start"}`}>
              {t.kind !== "user" && (
                <div className="mt-1 shrink-0 opacity-90">
                  {t.kind === "tool" ? <IconTool size={16} className="text-slate-500" /> : t.kind === "todo" || t.kind === "goal" ? <IconTarget size={16} className="text-amber-300" /> : t.kind === "note" ? <IconNote size={16} className="text-slate-500" /> : <EmotionBall mood={mood} size={26} />}
                </div>
              )}
              <div
                className={`max-w-[85%] md:max-w-[72%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${
                  t.kind === "user"
                    ? "bg-gradient-to-br from-accent/25 to-accent/10 border border-accent/25 rounded-tr-md"
                    : t.kind === "tool"
                      ? "bg-black/25 border border-white/[0.06] font-mono text-[11.5px] text-slate-400 rounded-tl-md"
                      : t.kind === "todo"
                        ? "bg-amber-400/[0.06] border border-amber-300/15 text-slate-300"
                        : t.kind === "goal"
                          ? "bg-amber-400/[0.08] border border-amber-300/20 text-amber-100"
                          : t.kind === "note"
                            ? "bg-black/20 border border-white/[0.05] text-slate-500 text-xs rounded-tl-md"
                            : "nh-card bg-ink-800/70 rounded-tl-md"
                }`}
              >
                {t.toolName && <div className="text-accent text-[11px] mb-1 font-medium">{t.toolName}</div>}
                {t.text || <span className="text-slate-600">（空）</span>}
              </div>
            </div>
          ))}
          {streaming && (
            <div className="flex gap-2.5 justify-start">
              <div className="mt-1 shrink-0">
                <EmotionBall mood="speaking" size={26} />
              </div>
              <div className="max-w-[85%] md:max-w-[72%] nh-card bg-ink-800/70 rounded-2xl rounded-tl-md px-4 py-2.5 text-sm whitespace-pre-wrap break-words nh-caret">{streaming}</div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        {error && <div className="mx-3 mb-2 rounded-xl bg-red-500/[0.08] border border-red-500/25 text-red-300 text-xs px-3.5 py-2.5">{error}</div>}

        {/* Composer */}
        <div className="border-t border-white/[0.06] bg-black/20 backdrop-blur-sm p-3 space-y-2">
          {busy && (
            <div className="flex gap-2">
              <input className="flex-1 rounded-xl bg-white/[0.04] border border-white/[0.08] px-3 py-1.5 text-sm" placeholder="运行中… 插入一段追问（steer）" value={steerText} onChange={(e) => setSteerText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && steer()} />
              <button className="rounded-xl border border-white/[0.1] px-3 py-1.5 text-sm hover:bg-white/[0.06]" onClick={steer}>
                插入
              </button>
              <button className="rounded-xl bg-red-500/85 px-3 py-1.5 text-sm font-medium flex items-center gap-1.5" onClick={interrupt}>
                <IconStop size={13} /> 中断
              </button>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              className="flex-1 resize-none rounded-2xl bg-white/[0.045] border border-white/[0.09] px-4 py-2.5 text-sm focus:outline-none focus:border-accent/60 transition-colors"
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
            <button className="self-end rounded-2xl bg-gradient-to-br from-accent to-accent-soft hover:brightness-110 px-4 py-2.5 text-sm font-medium text-ink-950 disabled:opacity-40 flex items-center gap-1.5" disabled={busy || !input.trim()} onClick={send}>
              <IconSend size={14} /> 发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Provider errors arrive as raw JSON — surface the human part. */
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
