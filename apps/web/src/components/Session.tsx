import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { api, foldTranscript, type SessionRow } from "../api"
import { EmotionBall, type Mood } from "./EmotionBall"
import { Markdown } from "./Markdown"
import { ModelPill } from "./ModelPill"
import { useStore } from "../store"
import { IconSend, IconStop, IconTool, IconCheck, IconSpinner, IconCircle, IconTarget, IconBrain, IconNote, IconChevron, IconArrowLeft } from "./icons"

export interface Turn {
  kind: "user" | "assistant" | "tool" | "thinking" | "todo" | "goal" | "note"
  text: string
  toolName?: string
  elapsed?: string
  isError?: boolean
}

const VERBS: Record<string, string> = { read: "读取", Read: "读取", search: "检索", Grep: "检索", write: "写入", Write: "写入", edit: "编辑", Edit: "编辑", bash: "运行", Bash: "运行", webfetch: "抓取", WebFetch: "抓取", skill: "技能", memory_search: "检索记忆", memory_write: "沉淀记忆", todo_write: "整理任务", spawn_agent: "派出子代理" }

function verbOf(name?: string): string {
  if (!name) return "执行"
  return VERBS[name] ?? "执行"
}

/** Ball mood from run state (pure; the view never writes if-chains). */
export function deriveMood(run: { busy: boolean; lastKind: "text" | "tool" | "thinking" | null; lastError: boolean; justSettled: boolean; interrupted: boolean }): Mood {
  if (run.interrupted) return "interrupted"
  if (run.lastError) return "error"
  if (run.justSettled) return "done"
  if (!run.busy) return "idle"
  if (run.lastKind === "tool") return "busy"
  if (run.lastKind === "thinking") return "thinking"
  return "speaking"
}

function prettyError(raw: string): string {
  try {
    const m = raw.match(/\{.*\}/)
    if (m) {
      const d = JSON.parse(m[0]) as { error?: { message?: string }; message?: string }
      const msg = d.error?.message ?? d.message
      if (msg) return (raw.split("{")[0]?.trim() ?? "") + msg
    }
  } catch {
    // fall through
  }
  return raw
}

function fmtElapsed(sec: number): string {
  const s = Math.floor(sec)
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/** Quiet inline row (codex style): 读取 · path · 3.2s — hover reveal, expandable. */
function InlineRow({ icon, label, detail, body, isError, defaultOpen = false }: { icon: ReactNode; label: string; detail?: string; body?: string; isError?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!body) {
    return (
      <div className="group flex h-7 items-center gap-2 px-1 text-[12px] text-slate-500 transition-colors hover:bg-white/[0.03]">
        {icon}
        <span className="font-medium text-slate-400">{label}</span>
        {detail && <span className="truncate text-[11px] text-slate-600">{detail}</span>}
      </div>
    )
  }
  return (
    <div className="group rounded-lg transition-colors hover:bg-white/[0.03]">
      <button className="flex h-7 w-full items-center gap-2 px-1 text-left" onClick={() => setOpen(!open)}>
        {icon}
        <span className={`text-[12px] font-medium ${isError ? "text-red-400" : "text-slate-400"}`}>{label}</span>
        {detail && <span className="truncate text-[11px] text-slate-600">{detail}</span>}
        <IconChevron size={11} className={`ml-auto shrink-0 text-slate-600 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <pre className={`mb-1 ml-4 mr-1 overflow-x-auto whitespace-pre-wrap break-all border-l border-white/[0.08] pl-3 text-[11px] leading-relaxed ${isError ? "text-red-300" : "text-slate-500"}`}>{body}</pre>}
    </div>
  )
}

/** Inline approval card (beautifului HITL) at stream bottom. */
function ApprovalCard({ approval, onSettle }: { approval: { id: string; kind: string; target: string }; onSettle: (allow: boolean) => void }) {
  return (
    <div className="rise mb-3 rounded-xl border border-amber-300/[0.25] bg-amber-400/[0.06] p-4">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-amber-400/20">
          <IconTarget size={12} className="text-amber-300" />
        </div>
        <span className="text-[13px] font-medium text-amber-100">需要你的批准（{approval.kind}）</span>
        <span className="ml-auto text-[10.5px] text-slate-500">超时自动拒绝</span>
      </div>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-white/[0.06] bg-black/30 p-2.5 text-[12px] text-slate-300">{approval.target}</pre>
      <div className="mt-3 flex gap-2">
        <button className="flex-1 rounded-lg border border-white/[0.1] py-1.5 text-xs text-slate-400 hover:bg-white/[0.05]" onClick={() => onSettle(false)}>
          跳过
        </button>
        <button className="flex-1 rounded-lg bg-emerald-500/90 py-1.5 text-xs font-medium text-ink-950 hover:bg-emerald-400" onClick={() => onSettle(true)}>
          继续
        </button>
      </div>
    </div>
  )
}

export function SessionView({ id, onBack }: { id: string; onBack: () => void }) {
  const { refreshSessions, setRunning, approvals, settleApproval } = useStore()
  const [turns, setTurns] = useState<Turn[]>([])
  const [parts, setParts] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [steerText, setSteerText] = useState("")
  const [error, setError] = useState("")
  const [input, setInput] = useState("")
  const [openRows, setOpenRows] = useState<Set<number>>(new Set())
  const [rows, setRows] = useState<SessionRow | undefined>(undefined)
  const [lastKind, setLastKind] = useState<"text" | "tool" | "thinking" | null>(null)
  const [interrupted, setInterrupted] = useState(false)
  const [justSettled, setJustSettled] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const startedAt = useRef(0)

  const allSessions = useStoreSessions()
  useEffect(() => {
    setRows(allSessions.find((s) => s.sessionId === id))
  }, [allSessions, id])

  const fold = useCallback((): Promise<void> => api.events(id).then((events) => setTurns(foldTranscript(events))).catch(() => setTurns([])), [id])

  useEffect(() => {
    setTurns([])
    setParts([])
    setInterrupted(false)
    void fold()
  }, [fold])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [turns, parts, elapsed])

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

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busyRef.current) return
    setError("")
    setInterrupted(false)
    setBusy(true)
    busyRef.current = true
    setRunning(true)
    startedAt.current = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 200)
    try {
      const controller = new AbortController()
      window.__nhAbort = controller
      const result = await api.prompt(id, text, (e) => {
        if (e.type === "text") {
          setLastKind("text")
          setParts((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === "assistant") return [...prev.slice(0, -1), { kind: "assistant", text: last.text + String((e as { text?: string }).text ?? "") }]
            return [...prev, { kind: "assistant", text: String((e as { text?: string }).text ?? "") }]
          })
        } else if (e.type === "reasoning") {
          setLastKind("thinking")
          setParts((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === "thinking") return [...prev.slice(0, -1), { kind: "thinking", text: last.text + String((e as { text?: string }).text ?? ""), elapsed: fmtElapsed((Date.now() - startedAt.current) / 1000) }]
            return [...prev, { kind: "thinking", text: String((e as { text?: string }).text ?? ""), elapsed: "0 秒" }]
          })
        } else if (e.type === "tool") {
          const d = e as { name: string; input: unknown }
          setLastKind("tool")
          setParts((prev) => [...prev, { kind: "tool", toolName: d.name, text: JSON.stringify(d.input ?? {}, null, 2), elapsed: "运行中" }])
        } else if (e.type === "tool-result") {
          const d = e as { name: string; output: unknown; isError?: boolean }
          setParts((prev) => {
            let idx = -1
            for (let i = prev.length - 1; i >= 0; i--) {
              const cand = prev[i]
              if (cand.kind === "tool" && cand.toolName === d.name && cand.elapsed === "运行中") {
                idx = i
                break
              }
            }
            if (idx < 0) return prev
            const next: Turn = { ...prev[idx]!, text: JSON.stringify(d.output ?? {}, null, 2).slice(0, 4000), isError: d.isError }
            return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)]
          })
        }
      }, controller.signal)
      if (result.error) setError(prettyError(result.error))
      if (!result.error && !controller.signal.aborted) {
        setJustSettled(true)
        setTimeout(() => setJustSettled(false), 1600)
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(prettyError(e instanceof Error ? e.message : String(e)))
    } finally {
      clearInterval(timer)
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
    setInterrupted(true)
  }

  const steer = async (): Promise<void> => {
    if (!steerText.trim()) return
    await api.steer(id, steerText.trim()).catch((e) => setError(prettyError(e instanceof Error ? e.message : String(e))))
    setSteerText("")
  }

  const mood = deriveMood({ busy, lastKind, lastError: !!error, justSettled, interrupted })
  const pending = approvals[0]

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
          {busy ? `工作中 ${fmtElapsed(elapsed)}` : "就绪"}
        </div>
      </div>

      {/* stream — document flow */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
          {turns.map((t, i) => (
            <TurnRow key={i} t={t} index={i} openRows={openRows} setOpenRows={setOpenRows} />
          ))}
          {parts.map((t, i) => (
            <TurnRow key={"live" + i} t={t} index={1000 + i} openRows={openRows} setOpenRows={setOpenRows} live />
          ))}
          {busy && parts.every((p) => p.kind !== "tool" && p.kind !== "thinking") && (
            <div className="mb-1">
              <InlineRow icon={<IconSpinner size={13} className="pulse-dot text-amber-300" />} label="思考中" detail={fmtElapsed(elapsed)} />
            </div>
          )}
          {pending && <ApprovalCard approval={pending} onSettle={(allow) => settleApproval(pending.id, allow)} />}
          <div ref={bottom} />
        </div>
      </div>

      {/* composer */}
      <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-1 md:px-6">
        {error && <div className="mb-2 rounded-xl bg-red-500/[0.07] border border-red-500/25 text-red-300 text-xs px-3.5 py-2.5">{error}</div>}
        {busy && (
          <div className="mb-2 flex items-center gap-2">
            <span className="pill !text-slate-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot" />
              运行中 {fmtElapsed(elapsed)}
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
            placeholder={busy ? "运行中…" : "继续对话…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="mb-1.5 mr-1 hidden items-center gap-2 text-[10px] text-slate-600 sm:flex">
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

function useStoreSessions(): SessionRow[] {
  const { sessions } = useStore()
  return sessions
}

/** Single transcript row — document flow (assistant has NO bubble). */
function TurnRow({ t, index, openRows, setOpenRows, live }: { t: Turn; index: number; openRows: Set<number>; setOpenRows: (f: (prev: Set<number>) => Set<number>) => void; live?: boolean }) {
  const isOpen = openRows.has(index)
  if (t.kind === "user") {
    return (
      <div className="rise mb-4 flex justify-end">
        <div className="max-w-[80%] rounded-xl border-l-2 border-accent bg-white/[0.045] px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-slate-200">{t.text}</div>
      </div>
    )
  }
  if (t.kind === "tool") {
    const label = verbOf(t.toolName) + " · " + (t.toolName ?? "")
    const icon = t.elapsed === "运行中" ? <IconSpinner size={13} className="pulse-dot text-amber-300" /> : <IconTool size={13} className={t.isError ? "text-red-400" : "text-slate-500"} />
    return (
      <div className="mb-1">
        <InlineRow icon={icon} label={label} detail={t.elapsed} body={t.text} isError={t.isError} defaultOpen={!!live && t.elapsed === "运行中"} />
      </div>
    )
  }
  if (t.kind === "thinking") {
    return (
      <div className="mb-2">
        <InlineRow icon={<IconBrain size={13} className="text-slate-600" />} label="思考" detail={t.elapsed ? `持续了 ${t.elapsed}` : undefined} body={t.text} />
      </div>
    )
  }
  if (t.kind === "todo") {
    return (
      <div className="mb-3 rounded-xl border border-amber-300/[0.14] bg-amber-400/[0.05] px-3.5 py-3">
        {t.text.split("\n").map((l, i) => {
          const done = l.startsWith("[done]")
          const now = l.startsWith("[now]")
          const content = l.replace(/^\[(done|now|\s)\]\s*/, "")
          return (
            <div key={i} className="flex items-center gap-2 py-0.5 text-[13px]">
              {done ? <IconCheck size={13} className="text-emerald-400" /> : now ? <IconSpinner size={13} className="text-amber-300" /> : <IconCircle size={13} className="text-slate-600" />}
              <span className={done ? "text-slate-500 line-through" : now ? "text-amber-100" : "text-slate-400"}>{content}</span>
            </div>
          )
        })}
      </div>
    )
  }
  if (t.kind === "goal") {
    return (
      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-amber-300/[0.16] bg-amber-400/[0.07] px-3.5 py-2.5">
        <IconTarget size={14} className="shrink-0 text-amber-300" />
        <span className="text-[13px] text-amber-100">{t.text}</span>
      </div>
    )
  }
  if (t.kind === "note") {
    return (
      <div className="mb-3 inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5">
        <IconNote size={12} className="text-slate-500" />
        <span className="text-[11.5px] text-slate-500">{t.text}</span>
      </div>
    )
  }
  return (
    <div className="mb-4 text-[14px] leading-relaxed">
      <Markdown text={t.text} />
    </div>
  )
}

declare global {
  interface Window {
    __nhAbort?: AbortController
  }
}
