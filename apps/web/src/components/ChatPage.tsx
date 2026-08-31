import { useCallback, useEffect, useRef, useState } from "react"
import { api, foldTranscript, type SessionRow } from "../api"

interface Turn {
  kind: "user" | "assistant" | "tool" | "todo" | "goal" | "note"
  text: string
  toolName?: string
}

const CURRENT_KEY = "NEWHORSE_CURRENT_SESSION"

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
      if (result.error) setError(result.error)
      // Refold from the durable log: the server-side truth (tools, todos…).
      const events = await api.events(sessionId)
      setTurns(foldTranscript(events))
      await refreshSessions()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
    await api.steer(current, steerText.trim()).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    setSteerText("")
  }

  return (
    <div className="flex h-full">
      {/* Session list */}
      <div className="hidden lg:flex flex-col w-64 shrink-0 border-r border-ink-700 bg-ink-900/40">
        <div className="px-3 py-2.5 text-xs uppercase tracking-wide text-slate-500 flex justify-between items-center">
          会话
          <button className="text-accent hover:text-accent-soft" title="新建会话" onClick={() => { setCurrent(""); setTurns([]) }}>
            ＋
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {sessions.map((s) => (
            <button key={s.sessionId} onClick={() => setCurrent(s.sessionId)} className={`w-full text-left px-3 py-2 text-sm border-l-2 ${current === s.sessionId ? "border-accent bg-ink-800 text-white" : "border-transparent text-slate-400 hover:bg-ink-800/60"}`}>
              <div className="truncate">{s.title || s.sessionId.slice(0, 8)}</div>
              <div className="text-[11px] text-slate-600">{s.updatedAt > 1000 ? new Date(s.updatedAt).toLocaleString() : "—"} {s.model ? `· ${s.model}` : ""}</div>
            </button>
          ))}
          {sessions.length === 0 && <div className="px-3 py-6 text-xs text-slate-600">还没有会话</div>}
        </div>
      </div>

      {/* Chat column */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto px-3 md:px-6 py-4 space-y-3">
          {turns.length === 0 && !streaming && (
            <div className="h-full flex items-center justify-center text-center text-slate-600 text-sm">
              <div>
                <div className="text-4xl mb-3">🐴</div>
                给管家一个任务吧。当前会话：{current ? current.slice(0, 8) : "新会话"}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.kind === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] md:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${
                  t.kind === "user"
                    ? "bg-accent/20 border border-accent/30"
                    : t.kind === "tool"
                      ? "bg-ink-900 border border-ink-700 font-mono text-xs text-slate-400"
                      : t.kind === "todo" || t.kind === "goal"
                        ? "bg-amber-500/10 border border-amber-500/20"
                        : t.kind === "note"
                          ? "bg-ink-900 border border-ink-700 text-slate-500 text-xs"
                          : "bg-ink-800 border border-ink-600"
                }`}
              >
                {t.toolName && <div className="text-accent text-xs mb-1">🔧 {t.toolName}</div>}
                {t.text || <span className="text-slate-600">（空）</span>}
              </div>
            </div>
          ))}
          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[85%] md:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm bg-ink-800 border border-ink-600 whitespace-pre-wrap break-words">{streaming}<span className="animate-pulse">▍</span></div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        {error && <div className="mx-3 mb-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs px-3 py-2">{error}</div>}

        {/* Composer */}
        <div className="border-t border-ink-700 bg-ink-900/50 p-3 space-y-2">
          {busy && (
            <div className="flex gap-2">
              <input className="flex-1 rounded-lg bg-ink-800 border border-ink-600 px-3 py-1.5 text-sm" placeholder="运行中… 插入一段追问（steer）" value={steerText} onChange={(e) => setSteerText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && steer()} />
              <button className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm hover:bg-ink-800" onClick={steer}>
                插入
              </button>
              <button className="rounded-lg bg-red-500/90 px-3 py-1.5 text-sm font-medium" onClick={interrupt}>
                中断
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              className="flex-1 resize-none rounded-xl bg-ink-800 border border-ink-600 px-3 py-2 text-sm focus:outline-none focus:border-accent"
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
            <button className="self-end rounded-xl bg-accent hover:bg-accent-soft px-4 py-2 text-sm font-medium text-ink-950 disabled:opacity-40" disabled={busy || !input.trim()} onClick={send}>
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    __nhAbort?: AbortController
  }
}
