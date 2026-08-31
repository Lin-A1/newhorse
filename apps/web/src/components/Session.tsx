import { useCallback, useEffect, useRef, useState } from "react"
import { api, foldTranscript } from "../api"
import { EmotionBall, type Mood } from "./EmotionBall"
import { Markdown } from "./Markdown"
import { IconSend, IconStop, IconTool, IconCheck, IconSpinner, IconCircle, IconTarget, IconBrain, IconNote, IconChevron, IconArrowLeft } from "./icons"
import { useStore } from "../store"

export interface Turn {
  kind: "user" | "assistant" | "tool" | "todo" | "goal" | "note"
  text: string
  toolName?: string
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

/** Inline model switcher pill: shows the effective model, pulls the
 *  provider's list, writes the new model on pick. */
export function ModelPill({ compact }: { compact?: boolean }): React.ReactElement {
  const { settings, reloadSettings, showToast } = useStore()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const model = settings?.model ?? "…"
  const pick = async (m: string): Promise<void> => {
    setOpen(false)
    if (m === model) return
    setBusy(true)
    await api.putSettings({ model: m }).catch(() => showToast("模型切换失败"))
    await reloadSettings()
    setBusy(false)
    showToast(`模型已切换为 ${m}（新会话生效）`)
  }
  return (
    <div className="relative">
      <button
        className={`pill hover:!text-slate-200 hover:border-white/[0.16] transition-colors ${busy ? "opacity-60" : ""}`}
        onClick={() => {
          if (!open) void api.models().then((r) => setModels(r.models)).catch(() => setModels([]))
          setOpen(!open)
        }}
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full bg-accent ${busy ? "pulse-dot" : ""}`} />
        {compact ? model.split("/").pop() : model}
        {!compact && <IconChevron size={11} className="opacity-60" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-2 z-30 w-64 rounded-xl border border-white/[0.09] bg-[#11141d] shadow-[0_20px_50px_rgba(0,0,0,0.55)] py-1.5 rise">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-slate-600">模型（写入设置，新会话生效）</div>
            {models.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">拉取失败或无列表</div>}
            {models.map((m) => (
              <button key={m} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-white/[0.05] ${m === model ? "text-accent" : "text-slate-300"}`} onClick={() => pick(m)}>
                {m === model ? <IconCheck size={12} /> : <span className="w-[12px]" />}
                <span className="truncate">{m}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Session view: transcript + composer, driven by the durable log. */
type LivePart =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: string; output?: string; isError?: boolean; done: boolean }

export function SessionView({ id, onBack }: { id: string; onBack: () => void }) {
  const { refreshSessions, setRunning } = useStore()
  const [turns, setTurns] = useState<Turn[]>([])
  const [parts, setParts] = useState<LivePart[]>([])
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [steerText, setSteerText] = useState("")
  const [error, setError] = useState("")
  const [input, setInput] = useState("")
  const [openTools, setOpenTools] = useState<Set<number>>(new Set())
  const [liveOpen, setLiveOpen] = useState<Set<number>>(new Set())
  const [rows, setRows] = useState<SessionRow | undefined>(undefined)
  const bottom = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const startedAt = useRef(0)

  const sessions = useStoreSessions()
  useEffect(() => {
    setRows(sessions.find((s) => s.sessionId === id))
  }, [sessions, id])

  const fold = useCallback((): Promise<void> => api.events(id).then((events) => setTurns(foldTranscript(events))).catch(() => setTurns([])), [id])

  useEffect(() => {
    setTurns([])
    void fold()
  }, [fold])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [turns, parts])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busyRef.current) return
    setError("")
    setBusy(true)
    busyRef.current = true
    setRunning(true)
    try {
      const controller = new AbortController()
      window.__nhAbort = controller
      startedAt.current = Date.now()
      setElapsed(0)
      const timer = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 200)
      const result = await api.prompt(id, text, (e) => {
        if (e.type === "text") {
          setParts((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === "text") return [...prev.slice(0, -1), { kind: "text", text: last.text + String((e as { text?: string }).text ?? "") }]
            return [...prev, { kind: "text", text: String((e as { text?: string }).text ?? "") }]
          })
        } else if (e.type === "tool") {
          const d = e as { name: string; input: unknown }
          setParts((prev) => [...prev, { kind: "tool", name: d.name, input: JSON.stringify(d.input ?? {}, null, 2), done: false }])
        } else if (e.type === "tool-result") {
          const d = e as { name: string; output: unknown; isError?: boolean }
          setParts((prev) => {
            let idx = -1
            for (let i = prev.length - 1; i >= 0; i--) {
              const cand = prev[i]
              if (cand.kind === "tool" && cand.name === d.name && !cand.done) { idx = i; break }
            }
            if (idx < 0) return prev
            const tool = prev[idx] as Extract<LivePart, { kind: "tool" }>
            void 0
            const next: LivePart = { ...tool, output: JSON.stringify(d.output ?? {}, null, 2).slice(0, 4000), isError: d.isError, done: true }
            return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)]
          })
        }
      }, controller.signal)
      clearInterval(timer)
      if (result.error) setError(prettyError(result.error))
    } catch (e) {
      setError(prettyError(e instanceof Error ? e.message : String(e)))
    } finally {
      setParts([])
      setInput("")
      await fold()
      await refreshSessions()
      setBusy(false)
      busyRef.current = false
      setRunning(false)
    }
  }

  const stop = async (): Promise<void> => {
    window.__nhAbort?.abort()
    await api.interrupt(id).catch(() => {})
  }

  const steer = async (): Promise<void> => {
    if (!steerText.trim()) return
    await api.steer(id, steerText.trim()).catch((e) => setError(prettyError(e instanceof Error ? e.message : String(e))))
    setSteerText("")
  }

  // Esc interrupts the running turn (codex keybind)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && busyRef.current) {
        window.__nhAbort?.abort()
        void api.interrupt(id).catch(() => {})
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [id])

  const mood: Mood = busy ? "thinking" : "idle"

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] bg-black/15 px-4 py-2.5">
        <button className="btn-ghost !p-1.5 lg:hidden" onClick={onBack} aria-label="返回">
          <IconArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-slate-200">{rows?.title || id.slice(0, 8)}</div>
        </div>
        <ModelPill compact />
        <div className="pill">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${busy ? "bg-emerald-400 pulse-dot" : "bg-slate-600"}`} />
          {busy ? "运行中" : "就绪"}
        </div>
      </div>

      {/* stream */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 md:px-6 py-6 space-y-4">
          {error && <div className="rounded-xl bg-red-500/[0.07] border border-red-500/25 text-red-300 text-xs px-3.5 py-2.5">{error}</div>}
          {turns.map((t, i) => (
            <TurnRow key={i} t={t} index={i} openTools={openTools} setOpenTools={setOpenTools} mood={mood} />
          ))}
          {parts.map((p, i) => {
        const last = i === parts.length - 1
        if (p.kind === "text") {
          return (
            <div key={"t" + i} className="flex gap-3 justify-start">
              <div className="mt-0.5 shrink-0">
                <EmotionBall mood={busy && last ? "speaking" : mood} size={28} />
              </div>
              <div className={"max-w-[88%] md:max-w-[80%] rounded-2xl rounded-tl-md panel px-4 py-3 text-sm " + (busy && last ? "caret" : "")}>{p.text}</div>
            </div>
          )
        }
        const open = liveOpen.has(i)
        return (
          <div key={"k" + i} className="flex gap-3 justify-start">
            <div className="mt-0.5 shrink-0 w-7">
              <div className="h-7 w-7 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center">
                {p.done ? <IconCheck size={13} className={p.isError ? "text-red-400" : "text-emerald-400"} /> : <IconSpinner size={13} className="text-amber-300" />}
              </div>
            </div>
            <div className="flex-1 max-w-[88%] md:max-w-[80%] rounded-xl border border-white/[0.07] bg-black/25 overflow-hidden">
              <button className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors" onClick={() => setLiveOpen((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n })}>
                <IconTool size={12} className="text-slate-500 shrink-0" />
                <span className="text-[12px] font-medium text-slate-300 shrink-0">{p.name}</span>
                <span className={"text-[11px] flex-1 " + (p.done ? (p.isError ? "text-red-400" : "text-emerald-500/80") : "shimmer-text")}>{p.done ? (p.isError ? "失败" : "完成") : "运行中…"}</span>
                <IconChevron size={12} className={"text-slate-600 transition-transform " + (open ? "rotate-90" : "")} />
              </button>
              {open && (
                <div className="border-t border-white/[0.05] px-3.5 py-2.5 space-y-2">
                  <pre className="text-[11px] leading-relaxed text-slate-400 font-mono overflow-x-auto whitespace-pre-wrap break-all">{p.input}</pre>
                  {p.output !== undefined && <pre className={"text-[11px] leading-relaxed font-mono overflow-x-auto whitespace-pre-wrap break-all border-t border-white/[0.05] pt-2 " + (p.isError ? "text-red-300" : "text-slate-400")}>{p.output}</pre>}
                </div>
              )}
            </div>
          </div>
        )
      })}
      <div ref={bottom} />
        </div>
      </div>

      {/* composer */}
      <div className="mx-auto w-full max-w-3xl px-4 md:px-6 pb-5 pt-1 w-full">
        {busy && (
          <div className="mb-2 flex items-center gap-2">
            <span className="pill !text-slate-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot" />
              运行中 {elapsed.toFixed(0)}s
            </span>
            <input className="input-base flex-1" placeholder="插入追问（steer），Esc 中断" value={steerText} onChange={(e) => setSteerText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); steer() } }} />
            <button className="flex items-center gap-1.5 rounded-[14px] bg-red-500/15 border border-red-500/30 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/25" onClick={stop}>
              <IconStop size={12} /> 中断
            </button>
          </div>
        )}
        <div className="panel-strong flex items-end gap-2 p-2 !rounded-[22px] transition-colors focus-within:border-accent/50">
          <textarea
            className="max-h-44 min-h-[42px] w-full flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-slate-600"
            rows={1}
            placeholder="继续对话…（Enter 发送）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="mb-1.5 mr-1 hidden sm:flex items-center gap-2 text-[10px] text-slate-600">
            <span className="flex items-center gap-1"><kbd className="nh-kbd">Enter</kbd> 发送</span>
            <span className="flex items-center gap-1"><kbd className="nh-kbd">Esc</kbd> 中断</span>
          </div>
          <button className="btn-primary mb-0.5 mr-0.5 h-8 w-8 !rounded-xl !p-0" disabled={busy || !input.trim()} onClick={send} aria-label="发送">
            <IconSend size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

// registry lookup used by the header fold helpers
import type { SessionRow } from "../api"
function useStoreSessions(): SessionRow[] {
  const { sessions } = useStore()
  return sessions
}

/** Single transcript row. */
function TurnRow({ t, index, openTools, setOpenTools, mood }: { t: Turn; index: number; openTools: Set<number>; setOpenTools: (f: (prev: Set<number>) => Set<number>) => void; mood: Mood }) {
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
      <div className={`min-w-0 ${t.kind === "user" ? "max-w-[80%] md:max-w-[70%]" : "flex-1 max-w-[88%] md:max-w-[80%]"}`}>
        {t.kind === "tool" ? (
          <div className="rounded-xl border border-white/[0.07] bg-black/25 overflow-hidden">
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors"
              onClick={() =>
                setOpenTools((prev) => {
                  const n = new Set(prev)
                  if (n.has(index)) n.delete(index)
                  else n.add(index)
                  return n
                })
              }
            >
              <IconTool size={12} className="text-slate-500 shrink-0" />
              <span className="text-[12px] font-medium text-slate-300 shrink-0">{t.toolName ?? "tool"}</span>
              {!isOpen && <span className="text-[11px] text-slate-600 truncate flex-1">{t.text.split("\n")[0]?.slice(0, 70)}</span>}
              <IconChevron size={12} className={`text-slate-600 transition-transform ml-auto ${isOpen ? "rotate-90" : ""}`} />
            </button>
            {isOpen && <pre className="px-3.5 pb-3 pt-2 text-[11px] leading-relaxed text-slate-400 font-mono overflow-x-auto whitespace-pre-wrap break-all border-t border-white/[0.05]">{t.text}</pre>}
          </div>
        ) : t.kind === "todo" ? (
          <div className="rounded-xl border border-amber-300/[0.14] bg-amber-400/[0.05] px-3.5 py-3 space-y-1.5">
            {t.text.split("\n").map((l, i) => {
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

declare global {
  interface Window {
    __nhAbort?: AbortController
  }
}
