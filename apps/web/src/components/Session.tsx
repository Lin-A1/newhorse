import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { api, foldTranscript, type SessionRow } from "../api"
import { EmotionBall } from "./EmotionBall"
import { Markdown } from "./Markdown"
import { ModelPill } from "./ModelPill"
import { takePendingPrompt, useStore } from "../store"
import { IconSend, IconStop, IconTool, IconCheck, IconSpinner, IconCircle, IconTarget, IconBrain, IconNote, IconChevron, IconFile, IconTerminal, IconPencil, IconSearch, IconCopy } from "./icons"

/** pick a semantic icon per tool name (read=file, bash=terminal, edit=pencil…) */
function toolIcon(name: string | undefined, cls: string): ReactNode {
  const n = name ?? ""
  if (/read|list/i.test(n)) return <IconFile size={13} className={cls} />
  if (/bash|run|exec/i.test(n)) return <IconTerminal size={13} className={cls} />
  if (/write|edit|create/i.test(n)) return <IconPencil size={13} className={cls} />
  if (/search|grep|fetch|web/i.test(n)) return <IconSearch size={13} className={cls} />
  if (/todo/i.test(n)) return <IconCheck size={13} className={cls} />
  if (/memory|skill|brain/i.test(n)) return <IconBrain size={13} className={cls} />
  return <IconTool size={13} className={cls} />
}

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
export function deriveMood(run: {
  busy: boolean
  lastKind: "text" | "tool" | "thinking" | null
  lastError: boolean
  justSettled: boolean
  interrupted: boolean
  receiving: boolean
  searching: boolean
  approvalPending: boolean
}): import("./EmotionBall").Mood {
  if (run.interrupted) return "interrupted"
  if (run.lastError) return "error"
  if (run.justSettled) return "done"
  if (!run.busy) return run.approvalPending ? "waiting" : "idle"
  if (run.receiving && run.lastKind === null) return "receiving"
  if (run.searching) return "searching"
  if (run.lastKind === "tool") return "busy"
  if (run.lastKind === "thinking") return "thinking"
  return "speaking"
}

const SEARCHY = /search|grep|fetch|web|memory_search|glob|list/i

/** 5×5 pixel-grid wave loader (beautifului signature). */
function PixelLoader({ className = "" }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={className} aria-hidden>
      {Array.from({ length: 25 }, (_, i) => {
        const x = (i % 5) * 3 + 1
        const y = Math.floor(i / 5) * 3 + 1
        return <rect key={i} className="px-dot" style={{ ["--i" as string]: i, animationDelay: `${(Math.abs(2 - (i % 5)) + Math.abs(2 - Math.floor(i / 5))) * 60}ms` }} x={x} y={y} width="2" height="2" rx="0.6" fill="currentColor" />
      })}
    </svg>
  )
}

function prettyError(raw: string): string {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
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

/** Tool row — beautifului Tool Chips style: icon chip + verb label + mono
 *  filename chip + right-aligned duration; expands to a mono payload block. */
function InlineRow({ icon, label, detail, monoDetail, body, isError, defaultOpen = false }: { icon: ReactNode; label: string; detail?: string; monoDetail?: boolean; body?: string; isError?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const chip = <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-surface2 ${isError ? "!border-bad/30 !bg-bad/10" : ""}`}>{icon}</span>
  const detailEl = detail && <span className={`truncate tnum text-[11.5px] text-faint ${monoDetail ? "font-mono" : ""}`}>{detail}</span>
  if (!body) {
    return (
      <div className="group flex h-9 items-center gap-2.5 rounded-lg border border-transparent px-1.5 text-[12px] transition-colors hover:border-line hover:bg-surface">
        {chip}
        <span className={`font-medium ${isError ? "text-bad" : "text-dim"}`}>{label}</span>
        {detailEl}
      </div>
    )
  }
  return (
    <div className="group">
      <button
        className={`flex h-9 w-full items-center gap-2.5 rounded-lg border px-1.5 text-left transition-colors ${open ? "border-line bg-surface" : "border-transparent hover:border-line hover:bg-surface"}`}
        onClick={() => setOpen(!open)}
      >
        {chip}
        <span className={`shrink-0 text-[13px] font-medium ${isError ? "text-bad" : "text-fg"}`}>{label}</span>
        {detailEl}
        <IconChevron size={12} className={`ml-auto shrink-0 text-faint transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <pre className={`mx-1.5 mb-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-surface2/60 p-2.5 font-mono text-[11px] leading-relaxed ${isError ? "text-bad/90" : "text-faint"}`}>{body}</pre>
      )}
    </div>
  )
}

/** Extract a human param subtitle from a tool payload (path/query/limit…). */
function toolDetail(toolName: string | undefined, body: string | undefined): string | undefined {
  if (!body) return undefined
  try {
    const d = JSON.parse(body) as { path?: string; query?: string; url?: string; command?: string; file_path?: string }
    const v = d.path ?? d.file_path ?? d.query ?? d.url ?? d.command
    if (typeof v === "string" && v) return v.replace(/^["\\]+|[\\"]+$/g, "")
  } catch {
    // truncated JSON from folding — fall through
    const m = body.match(/"(?:path|query|url|command)"\s*:\s*"([^"]{1,80})/)
    if (m) return m[1]
  }
  return undefined
}

export function SessionView({ id }: { id: string }) {
  const { refreshSessions, setRunning, setMood, setSessionStatus, approvals, settleApproval, showToast } = useStore()
  const [turns, setTurns] = useState<Turn[]>([])
  const [parts, setParts] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState("")
  const [input, setInput] = useState("")
  const [rows, setRows] = useState<SessionRow | undefined>(undefined)
  const [lastKind, setLastKind] = useState<"text" | "tool" | "thinking" | null>(null)
  const [interrupted, setInterrupted] = useState(false)
  const [justSettled, setJustSettled] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const startedAt = useRef(0)
  const sendRef = useRef<(t?: string) => Promise<void>>(async () => {})

  const { sessions } = useStore()
  useEffect(() => {
    setRows(sessions.find((s) => s.sessionId === id))
  }, [sessions, id])

  const [goal, setGoal] = useState<{ objective: string; status: string; tokenBudget?: number; tokensUsed?: number } | null>(null)
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalText, setGoalText] = useState("")
  const [goalBudget, setGoalBudget] = useState("")
  const [ctx, setCtx] = useState<{ estTokens: number; windowTokens?: number; ratio?: number } | null>(null)

  const fold = useCallback((): Promise<void> => api.events(id).then((events) => setTurns(foldTranscript(events))).catch(() => setTurns([])), [id])

  // goal + context meter load/refresh
  const loadMeta = useCallback((): void => {
    api.goal(id).then((r) => setGoal(r.goal ? { ...r.goal, tokensUsed: r.tokensUsed } : null)).catch(() => {})
    api.context(id).then(setCtx).catch(() => {})
  }, [id])

  useEffect(() => {
    loadMeta()
  }, [loadMeta, id])

  useEffect(() => {
    setTurns([])
    setParts([])
    setInterrupted(false)
    setError("")
    setMood("idle")
    setSessionStatus(false)
    void fold().then(() => {
      // Home-hero handoff: the first prompt was stashed before navigation.
      const pending = takePendingPrompt(id)
      if (pending) void sendRef.current(pending)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fold, setMood, setSessionStatus, id])

  // release the global ball when leaving the session
  useEffect(() => () => {
    setMood("idle")
    setSessionStatus(false)
  }, [setMood, setSessionStatus])

  // external updates (scheduled prompts, other clients) re-fold the transcript
  useEffect(() => {
    const onUpdated = (e: Event): void => {
      const detail = (e as CustomEvent<string>).detail
      if (!busyRef.current && (detail === undefined || detail === id)) void fold()
    }
    window.addEventListener("nh-session-updated", onUpdated)
    return () => window.removeEventListener("nh-session-updated", onUpdated)
  }, [fold, id])

  // stick to bottom only if the user is already near it (don't yank them while reading up)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])
  useEffect(() => {
    if (stickRef.current) bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [turns, parts, elapsed])

  // "receiving" = a turn just started and the model hasn't said/done anything yet
  const receiving = busy && lastKind === null
  // "searching" = the latest running tool is a retrieval kind
  const searching = parts.some((p) => p.kind === "tool" && p.elapsed === "运行中" && SEARCHY.test(p.toolName ?? ""))
  const mood = deriveMood({ busy, lastKind, lastError: !!error, justSettled, interrupted, receiving, searching, approvalPending: approvals.length > 0 })
  useEffect(() => {
    setMood(mood)
    setSessionStatus(busy, elapsed)
  }, [mood, busy, elapsed, setMood, setSessionStatus])

  // Esc interrupts the running turn (codex keybind) — but never while a modal
  // or popover is open (there Esc means "close this", not "stop the run")
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !busyRef.current) return
      if (document.querySelector('[role="dialog"],[data-nh-popover]')) return
      window.__nhAbort?.abort()
      void api.interrupt(id).catch(() => {})
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [id])

  const send = async (initial?: string): Promise<void> => {
    const text = (initial ?? input).trim()
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
            // settled: drop the 运行中 marker so the spinner gives way to the tool icon
            // mark error also when the tool returned an {error:…} payload (not just transport failures)
            const payloadError = typeof d.output === "object" && d.output !== null && ("error" in d.output || "Error" in d.output)
            const next: Turn = { ...prev[idx]!, text: JSON.stringify(d.output ?? {}, null, 2).slice(0, 4000), elapsed: "", isError: d.isError || payloadError }
            return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)]
          })
        }
      }, controller.signal)
      if (result.error) setError(prettyError(result.error))
      if (!result.error && !controller.signal.aborted) {
        setJustSettled(true)
        setTimeout(() => setJustSettled(false), 2200)
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
  sendRef.current = send

  const stop = async (): Promise<void> => {
    window.__nhAbort?.abort()
    await api.interrupt(id).catch(() => {})
    setInterrupted(true)
  }

  const steer = async (text: string): Promise<void> => {
    const body = text.trim()
    if (!body) return
    await api.steer(id, body).catch((e) => setError(prettyError(e instanceof Error ? e.message : String(e))))
    setInput("")
  }

  const pending = approvals[0]

  const saveGoal = async (): Promise<void> => {
    if (!goalText.trim()) return
    try {
      await api.setGoal(id, goalText.trim(), goalBudget ? Number(goalBudget) : undefined)
      setGoalOpen(false)
      loadMeta()
      showToast("目标已写入（模型可见）")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const exportMd = async (): Promise<void> => {
    const events = await api.events(id)
    const lines: string[] = [`# 会话 ${id.slice(0, 8)}`, ""]
    for (const t of foldTranscript(events)) {
      const nl = "\n"
      if (t.kind === "user") lines.push(`**你：** ${t.text}`, "")
      else if (t.kind === "assistant") lines.push(`**管家：**`, t.text, "")
      else if (t.kind === "tool") lines.push(`> 工具 ${t.toolName ?? ""}：`, ...t.text.split(nl).map((l) => `> ${l}`), "")
      else if (t.kind === "todo") lines.push(`**任务清单**`, "", ...t.text.split(nl).map((l) => `- ${l}`), "")
      else if (t.kind === "goal") lines.push(`**目标：** ${t.text}`, "")
      else if (t.kind === "note") lines.push(`_(${t.text})_`, "")
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `newhorse-${id.slice(0, 8)}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="flex h-full flex-col">
      {/* goal + context strip */}
      <div className="flex items-center gap-2 border-b border-line bg-black/10 px-4 py-1.5 text-[11px]">
        {goal ? (
          <button className="flex min-w-0 items-center gap-1.5 text-dim hover:text-fg" onClick={() => setGoalOpen(!goalOpen)} title="查看/编辑目标">
            <span className="font-medium text-ok">目标</span>
            <span className="truncate">{goal.objective}</span>
            {goal.tokenBudget !== undefined && (
              <span className="tnum shrink-0">
                {goal.tokensUsed ?? 0}/{goal.tokenBudget}
              </span>
            )}
          </button>
        ) : (
          <button className="text-faint hover:text-fg" onClick={() => setGoalOpen(!goalOpen)}>
            + 设定目标
          </button>
        )}
        {ctx && ctx.windowTokens !== undefined && ctx.ratio !== undefined && (
          <div className="ml-auto flex items-center gap-1.5" title={`约 ${ctx.estTokens} / ${ctx.windowTokens} tokens`}>
            <div className="h-1 w-20 overflow-hidden rounded-full bg-white/[0.08]">
              <div className={`h-full rounded-full ${ctx.ratio > 0.8 ? "bg-bad" : "bg-accent"}`} style={{ width: `${Math.round(ctx.ratio * 100)}%` }} />
            </div>
            <span className="tnum text-faint">{Math.round(ctx.ratio * 100)}%</span>
          </div>
        )}
        <button className="ml-auto text-faint hover:text-fg" title="导出会话 Markdown" onClick={() => void exportMd()}>
          导出
        </button>
      </div>
      {goalOpen && (
        <div className="nh-rise border-b border-line bg-black/15 p-4 space-y-2.5">
          <textarea className="input-base resize-none" rows={2} placeholder="目标（模型可见，将引导整个会话）" value={goalText} onChange={(e) => setGoalText(e.target.value)} />
          <div className="flex items-center gap-2">
            <input type="number" className="input-base !w-40" placeholder="token 预算（可选）" value={goalBudget} onChange={(e) => setGoalBudget(e.target.value)} />
            <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void saveGoal()}>
              写入目标
            </button>
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setGoalOpen(false)}>
              取消
            </button>
          </div>
          {goal && <div className="text-[11px] text-faint">当前：{goal.objective}（{goal.status}）· 已用 {goal.tokensUsed ?? 0} tokens</div>}
        </div>
      )}
      {/* stream — document flow */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-6 md:px-6 xl:max-w-[1000px] 2xl:max-w-[1160px]">
          {turns.length === 0 && parts.length === 0 && !busy && (
            <div className="fade flex flex-col items-center gap-4 py-16 text-center">
              <div className="hero-float">
                <EmotionBall mood="idle" size={72} />
              </div>
              <div>
                <div className="text-[14px] font-medium text-dim">这个会话还没有内容</div>
                <div className="mt-1 text-[12px] text-faint">在下方输入任务，管家会自己读文件、跑工具、记重点</div>
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <TurnRow key={i} t={t} index={i} />
          ))}
          {/* ZCode-style work separator between the user's message and the run */}
          {busy && (
            <div className="rise my-4 flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-line" />
              <span className="shimmer-text tnum text-[11px] font-medium">已工作 {fmtElapsed(elapsed)}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          {parts.map((t, i) => (
            <TurnRow key={"live" + i} t={t} index={1000 + i} live />
          ))}
          {busy && parts.every((p) => p.kind !== "tool" && p.kind !== "thinking") && (
            <div className="mb-2 flex items-center gap-2.5 px-2 py-1.5 text-dim">
              <PixelLoader className="text-dim" />
              <span className="shimmer-text text-[13px] font-medium">思考中</span>
              <span className="tnum text-[11px] text-faint">{elapsed.toFixed(1)}s</span>
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>

      {/* composer dock */}
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5 pt-1 md:px-6 xl:max-w-[1000px] 2xl:max-w-[1160px]">
        {pending && (
          <div className="dock-tray rise rounded-b-none rounded-t-[20px] p-3.5" data-nh-popover>
            <div className="mb-2 flex items-center gap-2">
              <div className="flex h-5 w-5 items-center justify-center rounded-md bg-warn/20">
                <IconTarget size={12} className="text-warn" />
              </div>
              <span className="text-[13px] font-medium text-warn">需要你的批准 · {pending.kind}</span>
              <span className="tnum ml-auto rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-faint">1 / {approvals.length}</span>
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-inset p-2.5 text-[12px] leading-relaxed text-dim">{pending.target}</pre>
            <div className="mt-2.5 flex gap-2">
              <button className="btn-ghost flex-1 !py-1.5 !text-xs" onClick={() => void settleApproval(pending.id, false)}>
                跳过
              </button>
              <button className="btn-ok flex-1 !py-1.5 !text-xs" onClick={() => void settleApproval(pending.id, true)}>
                继续 <kbd className="nh-kbd !border-white/25 !bg-white/15 !text-inherit">⏎</kbd>
              </button>
            </div>
          </div>
        )}
        {busy && !pending && (
          <div className="dock-tray rise flex items-center gap-2 px-3 py-2" style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
            <span className="pill shrink-0 !text-dim tnum">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-ok pulse-dot" />
              工作中 · {fmtElapsed(elapsed)}
            </span>
            <span className="ml-auto hidden text-[10.5px] text-faint sm:block">在下方输入可插入追问</span>
            <button className="btn-danger shrink-0 !rounded-lg !px-2.5 !py-1 !text-[11px]" onClick={() => void stop()}>
              <IconStop size={10} /> 中断
            </button>
          </div>
        )}
        {error && (
          <div className="dock-tray rise flex items-start gap-2.5 rounded-b-none rounded-t-[16px] border-bad/25 !bg-bad/[0.07] p-3">
            <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bad/25 text-[10px] font-bold text-bad">!</div>
            <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-bad/90">{error}</div>
            <button className="btn-ghost shrink-0 !rounded-lg !px-2.5 !py-1 !text-[11px]" onClick={() => window.dispatchEvent(new CustomEvent("nh-open-settings"))}>
              设置
            </button>
          </div>
        )}
        <div className="panel-strong composer-solid overflow-hidden !rounded-[18px] transition-shadow focus-within:!border-linestrong">
          <textarea
            className="max-h-44 min-h-[46px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm outline-none placeholder:text-faint"
            rows={1}
            placeholder={busy ? "运行中…输入追问，Enter 插入（Esc 中断）" : "继续对话…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (busy) void steer(input)
                else void send()
              }
            }}
          />
          {/* bottom toolbar (ZCode-style composer) */}
          <div className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
            <ModelPill compact />
            {!busy && (
              <span className="hidden items-center gap-2 text-[10px] text-faint lg:flex">
                <span className="flex items-center gap-1"><kbd className="nh-kbd">Enter</kbd> 发送</span>
              </span>
            )}
            <span className="flex-1" />
            {busy ? (
              <button className="btn-danger flex h-8 w-8 shrink-0 items-center justify-center !rounded-full !p-0" onClick={() => void stop()} aria-label="中断">
                <IconStop size={13} />
              </button>
            ) : (
              <button className="btn-primary h-8 w-8 shrink-0 !rounded-full !p-0" disabled={!input.trim()} onClick={() => void send()} aria-label="发送">
                <IconSend size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Single transcript row — document flow (assistant has NO bubble). */
function TurnRow({ t, live }: { t: Turn; index: number; live?: boolean }) {
  if (t.kind === "user") {
    return (
      <div className="rise mb-5 flex justify-end">
        <div className="max-w-[82%] rounded-xl rounded-br-sm border border-line bg-surface2 px-3 py-1.5 text-[13.5px] whitespace-pre-wrap break-words leading-relaxed text-fg">{t.text}</div>
      </div>
    )
  }
  if (t.kind === "tool") {
    const label = verbOf(t.toolName)
    const running = live && t.elapsed === "运行中"
    const icon = running ? <IconSpinner size={13} className="spin text-warn" /> : toolIcon(t.toolName, t.isError ? "text-bad" : "text-faint")
    const param = toolDetail(t.toolName, t.text)
    const dur = running ? "运行中" : t.elapsed
    const detail = [param, dur].filter(Boolean).join(" · ")
    return (
      <div className="mb-1">
        <InlineRow icon={icon} label={label} detail={detail || undefined} monoDetail body={t.text} isError={t.isError} defaultOpen={running} />
      </div>
    )
  }
  if (t.kind === "thinking") {
    return (
      <div className="mb-1">
        <InlineRow icon={<IconBrain size={13} className="text-faint" />} label="思考" detail={t.elapsed ? `持续了 ${t.elapsed}` : undefined} body={t.text} />
      </div>
    )
  }
  if (t.kind === "todo") {
    return (
      <div className="mb-3 overflow-hidden rounded-xl border border-line bg-surface" role="list">
        {t.text.split("\n").map((l, i) => {
          const done = l.startsWith("[done]")
          const now = l.startsWith("[now]")
          const content = l.replace(/^\[(done|now|\s)\]\s*/, "")
          return (
            <div
              key={i}
              className={`todo-item rise flex h-9 items-center gap-2.5 px-2.5 text-[13px] transition-colors hover:bg-surface2 ${i > 0 ? "border-t border-line/60" : ""} ${done ? "done text-faint" : now ? "text-fg" : "text-dim"}`}
              style={{ ["--d" as string]: `${i * 80}ms` }}
              role="listitem"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                {done ? (
                  <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-ok/15 text-ok">
                    <IconCheck size={11} />
                  </span>
                ) : now ? (
                  <span className="h-2 w-2 rounded-full bg-warn pulse-dot" />
                ) : (
                  <IconCircle size={13} className="text-faint" />
                )}
              </span>
              {/* strikethrough must hug the text — flex spacer keeps the line off the rest of the row */}
              <span className="todo-text min-w-0 truncate">{content}</span>
              <span className="min-w-0 flex-1" />
              {done && <span className="inline-flex h-[22px] shrink-0 items-center rounded-full bg-ok/10 px-2 text-[11px] font-medium text-ok">已完成</span>}
            </div>
          )
        })}
      </div>
    )
  }
  if (t.kind === "goal") {
    return (
      <div className="rise mb-3 flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5">
        <IconTarget size={14} className="shrink-0 text-warn" />
        <span className="text-[13px] font-medium text-fg">{t.text}</span>
      </div>
    )
  }
  if (t.kind === "note") {
    return (
      <div className="rise mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5">
        <IconNote size={12} className="text-faint" />
        <span className="text-[11.5px] text-faint">{t.text}</span>
      </div>
    )
  }
  return (
    <div className="group/msg mb-4">
      <div className="text-[14px] leading-relaxed text-fg">
        <Markdown text={t.text} />
      </div>
      {/* action bar (shared grammar with the code-block copy): hover reveals
          a real button, right-aligned so it never sits orphaned in the flow */}
      <div className="mt-1 flex justify-end opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100">
        <button
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2 py-1 text-[11px] text-faint shadow-card transition-colors hover:border-linestrong hover:text-fg"
          onClick={() => void navigator.clipboard?.writeText(t.text).catch(() => {})}
          aria-label="复制这段回复"
        >
          <IconCopy size={11} />
          复制
        </button>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    __nhAbort?: AbortController
  }
}
