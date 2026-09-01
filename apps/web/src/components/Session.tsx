import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { api, foldFileChanges, foldTranscript, type FileChange, type SessionRow, type StoredEventRow } from "../api"
import { EmotionBall } from "./EmotionBall"
import { Markdown } from "./Markdown"
import { ModelPill } from "./ModelPill"
import { ContextPanel, type ContextStats } from "./ContextPanel"
import { FileChanges } from "./FileChanges"
import { FileTree } from "./FileTree"
import { pendingPrefills, pendingPrompts, takePendingPrefill, takePendingPrompt, useStore } from "../store"
import { IconSend, IconStop, IconTool, IconCheck, IconSpinner, IconCircle, IconTarget, IconBrain, IconNote, IconChevron, IconFile, IconFolder, IconTerminal, IconPencil, IconSearch, IconCopy, IconButler, IconShield, IconPaperclip } from "./icons"

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
  /** seq of the user turn's Prompted event — the fork point for 回退重发 */
  seq?: number
  /** image attachments on a user turn (raw base64, mirrored from the log) */
  images?: Array<{ mime: string; data: string }>
  /** structured note subtype ("memory" renders as a Context Card) */
  note?: "memory"
  /** store-level write time — hover timestamp (opencode detail) */
  ts?: number
}

/** Client-side attachment caps — the server enforces the same numbers. */
const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 4_000_000

/** Read an image file into a raw-base64 attachment (no data: prefix). */
function fileToAttachment(file: File): Promise<{ mime: string; data: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (): void => {
      const url = String(reader.result ?? "")
      const comma = url.indexOf(",")
      resolve({ mime: file.type || "image/png", data: comma >= 0 ? url.slice(comma + 1) : url, name: file.name })
    }
    reader.onerror = (): void => reject(new Error(`读取 ${file.name} 失败`))
    reader.readAsDataURL(file)
  })
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
  const { refreshSessions, setRunning, setMood, setSessionStatus, approvals, settleApproval, showToast, settings, setView } = useStore()
  const [policy, setPolicyState] = useState<"strict" | "readonly" | "trusted">("strict")
  const [policyAnchor, setPolicyAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const [panel, setPanel] = useState<"tree" | "changes" | "context" | null>(null)
  const [commands, setCommands] = useState<Array<{ name: string; description?: string }>>([])
  const [cmdSelected, setCmdSelected] = useState(0)
  const [slashAnchor, setSlashAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [events, setEvents] = useState<StoredEventRow[]>([])
  const [parts, setParts] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState("")
  const [input, setInput] = useState("")
  const [attachments, setAttachments] = useState<Array<{ mime: string; data: string; name: string }>>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
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
  const [todos, setTodos] = useState<Array<{ content: string; status: string }>>([])
  const [dockOpen, setDockOpen] = useState(true)
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalText, setGoalText] = useState("")
  const [goalBudget, setGoalBudget] = useState("")
  const [ctx, setCtx] = useState<{ estTokens: number; windowTokens?: number; ratio?: number } | null>(null)
  // close the goal form when the composer gets focus (they share vertical space)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    const onFocus = (): void => setGoalOpen(false)
    el.addEventListener("focus", onFocus)
    return () => el.removeEventListener("focus", onFocus)
  }, [])

  const fold = useCallback((): Promise<void> => api.events(id).then((evs) => {
    setEvents(evs)
    setTurns(foldTranscript(evs))
  }).catch(() => {
    setEvents([])
    setTurns([])
  }), [id])
  const fileChanges = useMemo(() => foldFileChanges(events), [events])
  const systemPrompt = useMemo(() => {
    const sys = events.find((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "system")
    return (sys?.data as { message?: { text?: string } } | undefined)?.message?.text
  }, [events])
  const tokensUsed = useMemo(
    () => events.reduce((n, e) => (e.type === "Session.StepEnded" ? n + ((e.data?.usage as { inputTokens?: number; outputTokens?: number } | undefined)?.inputTokens ?? 0) + ((e.data?.usage as { outputTokens?: number } | undefined)?.outputTokens ?? 0) : n), 0),
    [events],
  )

  const contextStats: ContextStats = useMemo(() => {
    const users = events.filter((e) => e.type === "Session.Prompted").length
    const assistants = events.filter((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "assistant").length
    const tools = events.filter((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "tool").length
    return {
      messages: users + assistants + tools,
      userMessages: users,
      assistantMessages: assistants,
      toolMessages: tools,
      model: rows?.model ?? settings?.model,
      windowTokens: ctx?.windowTokens,
      estTokens: ctx?.estTokens ?? 0,
      ratio: ctx?.ratio,
      tokensUsed,
      goalBudget: goal?.tokenBudget,
      goalUsed: goal?.tokensUsed,
    }
  }, [events, rows?.model, settings?.model, ctx, tokensUsed, goal])

  // goal + context meter load/refresh
  const loadMeta = useCallback((): void => {
    api.goal(id).then((r) => setGoal(r.goal ? { ...r.goal, tokensUsed: r.tokensUsed } : null)).catch(() => {})
    api.context(id).then(setCtx).catch(() => {})
    api.todos(id).then((r) => setTodos(r.todos)).catch(() => setTodos([]))
  }, [id])

  // per-session permission level (分级 harness) — server is authoritative
  useEffect(() => {
    api.policy(id).then((r) => setPolicyState(r.policy)).catch(() => setPolicyState(settings?.approvalPolicy === "trusted" ? "trusted" : settings?.approvalPolicy === "readonly" ? "readonly" : "strict"))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // slash-command catalog, loaded lazily the first time the composer types "/"
  useEffect(() => {
    if (!input.startsWith("/") || commands.length > 0) return
    void api.commands().then((r) => setCommands(r.commands)).catch(() => setCommands([]))
  }, [input, commands.length])

  const changePolicy = async (p: "strict" | "readonly" | "trusted"): Promise<void> => {
    setPolicyAnchor(null)
    try {
      await api.setPolicy(id, p)
      setPolicyState(p)
      showToast(p === "readonly" ? "已切换为只读（计划模式）" : p === "trusted" ? "已切换为完全访问" : "已切换为默认审批")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  // --- slash commands: "/" opens the popover; Enter expands the command body
  // into the composer (server-authoritative via the plugin command seam) ---
  const slashTyping = input.startsWith("/") && !input.includes(" ") && !busy
  const matchingCommands = slashTyping ? commands.filter((c) => c.name.toLowerCase().startsWith(input.slice(1).toLowerCase())) : []
  // The composer panel is overflow-hidden (rounded corners), so both popovers
  // are portal'd to <body> with fixed anchors — never clipped.
  const composerBoxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!slashTyping) {
      setSlashAnchor(null)
      return
    }
    const el = composerBoxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setSlashAnchor({ left: r.left + 8, bottom: window.innerHeight - r.top + 6, width: r.width - 16 })
  }, [slashTyping, input])
  // Outside click / Escape dismisses the portal'd popovers (same contract as
  // ModelPill's popover; the session Esc handler sees data-nh-popover and
  // correctly does NOT abort the run while a menu is open).
  useEffect(() => {
    if (!policyAnchor && !slashAnchor) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest("[data-nh-popover],[data-nh-popover-anchor]")) return
      setPolicyAnchor(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return
      if (policyAnchor) {
        e.stopPropagation()
        setPolicyAnchor(null)
      }
      if (slashAnchor) setSlashAnchor(null)
    }
    // a fixed-position anchor goes stale on resize — close rather than misplace
    const onResize = (): void => {
      setPolicyAnchor(null)
      setSlashAnchor(null)
    }
    document.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("resize", onResize)
    return () => {
      document.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("resize", onResize)
    }
  }, [policyAnchor, slashAnchor])
  // keep the slash highlight in sync with the filtered list
  useEffect(() => setCmdSelected(0), [input])
  const expandCommand = async (line: string): Promise<void> => {
    try {
      const r = await api.runCommand(id, line)
      if (typeof r.output === "string") setInput(r.output)
      else showToast("命令没有返回文本")
    } catch (e) {
      showToast(e instanceof Error ? e.message.replace(/^\d+\s*/, "").slice(0, 80) : String(e))
    }
  }

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
      // 回退重发 handoff: a fork stashed the rewound turn's text — prefill the
      // composer for editing, but never auto-send (opencode edit-and-resend).
      const prefill = takePendingPrefill(id)
      if (prefill !== undefined) setInput(prefill)
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
  const [showJump, setShowJump] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      stickRef.current = stuck
      setShowJump(!stuck)
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

  const addAttachments = async (files: Iterable<File | null>): Promise<void> => {
    const imgs = [...files].filter((f): f is File => !!f && /^image\/(png|jpeg|webp|gif)$/.test(f.type))
    if (imgs.length === 0) return
    const room = MAX_IMAGES - attachments.length
    if (room <= 0) {
      showToast(`一次最多 ${MAX_IMAGES} 张图片`)
      return
    }
    const accepted = imgs.slice(0, room)
    if (accepted.length < imgs.length) showToast(`一次最多 ${MAX_IMAGES} 张，已接收前 ${accepted.length} 张`)
    const tooBig = imgs.find((f) => f.size > MAX_IMAGE_BYTES)
    if (tooBig) {
      showToast(`图片过大（${(tooBig.size / 1_000_000).toFixed(1)}MB），单张上限 ${MAX_IMAGE_BYTES / 1_000_000}MB`)
      return
    }
    try {
      const next = await Promise.all(accepted.map(fileToAttachment))
      setAttachments((a) => [...a, ...next].slice(0, MAX_IMAGES))
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const send = async (initial?: string): Promise<void> => {
    const text = (initial ?? input).trim()
    if ((!text && attachments.length === 0) || busyRef.current) return
    const sending = attachments
    setError("")
    setInterrupted(false)
    setBusy(true)
    busyRef.current = true
    setRunning(true)
    setAttachments([])
    startedAt.current = Date.now()
    setElapsed(0)
    // optimistic user turn: attachments visible immediately; the post-run fold
    // replaces it with the authoritative log projection
    setTurns((prev) => [...prev, { kind: "user", text, ...(sending.length ? { images: sending.map(({ mime, data }) => ({ mime, data })) } : {}) }])
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
      }, controller.signal, sending.length ? sending.map(({ mime, data }) => ({ mime, data })) : undefined)
      if (result.error) setError(prettyError(result.error))
      if (!result.error && !controller.signal.aborted) {
        setJustSettled(true)
        setTimeout(() => setJustSettled(false), 2200)
        // run finished while the user is elsewhere → a gentle system nudge
        // (opt-in via settings; the browser permission is requested there)
        if (document.hidden && localStorage.getItem("NEWHORSE_NOTIFY") === "on" && typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification("newhorse · 任务完成", { body: `${text.slice(0, 60)}${text.length > 60 ? "…" : ""}` })
          } catch {
            // notification is best-effort, never load-bearing
          }
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(prettyError(e instanceof Error ? e.message : String(e)))
    } finally {
      clearInterval(timer)
      setParts([])
      setInput("")
      // reset the imperative auto-grow height (an empty composer must not
      // stay tall after send)
      if (composerRef.current) composerRef.current.style.height = "auto"
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

  /** 回退重发 (opencode edit-and-resend): fork the log BEFORE this user turn,
   *  attach the fork as a live session, prefill its composer with the rewound
   *  text for editing — the old session stays intact (append-only philosophy).
   *  The role is passed on attach too (belt) — createApp also restores it from
   *  the copied Session.Created (suspenders). `regenerate` reuses the same
   *  fork with AUTO-SEND (codex retry): the composer consumes pendingPrompts. */
  const forkFromTurn = async (t: Turn, mode: "edit" | "regenerate"): Promise<void> => {
    if (t.seq === undefined) {
      showToast("这条消息没有可定位的分叉点")
      return
    }
    try {
      const ws = localStorage.getItem("NEWHORSE_WORKSPACE") || settings?.workspace || undefined
      const r = await api.forkSession(id, t.seq - 1)
      await api.createSession(r.sessionId, ws, rows?.role === "butler")
      if (mode === "regenerate") pendingPrompts.set(r.sessionId, t.text)
      else pendingPrefills.set(r.sessionId, t.text)
      localStorage.setItem("NEWHORSE_CURRENT_SESSION", r.sessionId)
      window.dispatchEvent(new CustomEvent("nh-session-updated", { detail: r.sessionId }))
      setView({ kind: "session", id: r.sessionId })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }
  const forkAndRewind = (t: Turn): Promise<void> => forkFromTurn(t, "edit")

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
      else if (t.kind === "assistant") lines.push(`**newhorse：**`, t.text, "")
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
      {/* goal + context meta bar: goal on the left, session tools on the right */}
      <div className="flex items-center gap-2 border-b border-line bg-surface2/60 px-4 py-1.5 text-[11px]">
        {rows?.role === "butler" && (
          <span className="pill shrink-0 !border-accent/30 !bg-accent/10 !py-0 !text-[10px] !text-accent" title="newhorse 常驻会话：拆解任务、调度子代理；动作全部审计">
            <EmotionBall mood="idle" size={12} />
            newhorse
          </span>
        )}
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
          <button className="shrink-0 text-faint hover:text-fg" onClick={() => setGoalOpen(!goalOpen)}>
            + 设定目标
          </button>
        )}
        {ctx && ctx.windowTokens !== undefined && ctx.ratio !== undefined && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5" title={`约 ${ctx.estTokens} / ${ctx.windowTokens} tokens`}>
            <div className="h-1 w-20 overflow-hidden rounded-full bg-line">
              <div className={`h-full rounded-full ${ctx.ratio > 0.8 ? "bg-bad" : "bg-accent"}`} style={{ width: `${Math.round(ctx.ratio * 100)}%` }} />
            </div>
            <span className="tnum text-faint">{Math.round(ctx.ratio * 100)}%</span>
          </div>
        )}
        <span className="min-w-2 flex-1" />
        {fileChanges.length > 0 && (
          <button
            className={`tnum shrink-0 rounded-md px-1.5 py-0.5 transition-colors ${panel === "changes" ? "bg-surface2 text-accent" : "text-faint hover:bg-surface2 hover:text-fg"}`}
            title="本次会话改动的文件"
            onClick={() => setPanel((v) => (v === "changes" ? null : "changes"))}
          >
            变更 {fileChanges.length}
          </button>
        )}
        <button className={`shrink-0 transition-colors ${panel === "tree" ? "text-accent" : "text-faint hover:text-fg"}`} title="工作区文件树" onClick={() => setPanel((v) => (v === "tree" ? null : "tree"))}>
          <IconFolder size={12} />
        </button>
        <button className={`tnum shrink-0 transition-colors ${panel === "context" ? "bg-surface2 text-accent" : "text-faint hover:bg-surface2 hover:text-fg"}`} title="会话上下文：统计 / 构成 / 系统提示词" onClick={() => setPanel((v) => (v === "context" ? null : "context"))}>
          上下文
        </button>
        {tokensUsed > 0 && (
          <span className="tnum shrink-0 text-faint" title="本会话累计输入+输出 tokens（事件日志折叠）">
            {tokensUsed >= 10_000 ? `${(tokensUsed / 1000).toFixed(1)}k` : tokensUsed} tok
          </span>
        )}
        <button className="shrink-0 text-faint hover:text-fg" title="导出会话 Markdown" onClick={() => void exportMd()}>
          导出
        </button>
      </div>
      {goalOpen && (
        <div className="nh-rise shrink-0 border-b border-line bg-surface2/80 p-4 space-y-2.5">
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
      {/* body: transcript+composer on the left, optional file tree on the right */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
      {/* stream — document flow */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-6 md:px-6 xl:max-w-[1000px] 2xl:max-w-[1160px]">
          {turns.length === 0 && parts.length === 0 && !busy && (
            <div className="fade flex flex-col items-center gap-4 py-16 text-center">
              <div>
                <div className="text-[14px] font-medium text-dim">这个会话还没有内容</div>
                <div className="mt-1 text-[12px] text-faint">在下方输入任务，newhorse 会自己读文件、跑工具、调度子代理</div>
              </div>
              <div className="mt-2 flex max-w-md flex-wrap justify-center gap-2">
                {["梳理这个项目的目录结构", "给当前改动写一次提交信息", "检查最近的改动有没有遗漏"].map((hint) => (
                  <button
                    key={hint}
                    className="rounded-full border border-linestrong bg-surface2 px-3 py-1.5 text-[12px] text-dim transition-all hover:-translate-y-0.5 hover:text-fg"
                    onClick={() => setInput(hint)}
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <TurnRow key={i} t={t} index={i} hide={t.kind === "todo"} sessionId={id} showToast={showToast} onFork={(tt) => void forkAndRewind(tt)} onRegenerate={(tt) => void forkFromTurn(tt, "regenerate")} />
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
            <TurnRow key={"live" + i} t={t} index={1000 + i} live sessionId={id} showToast={showToast} />
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
        {/* 回到最新: appears once the user scrolled away from the live tail */}
        {showJump && (
          <button
            className="pop-in absolute bottom-4 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-linestrong bg-surface2/95 px-3 text-[11.5px] text-fg shadow-raise backdrop-blur transition-colors hover:border-linestrong"
            onClick={() => {
              stickRef.current = true
              setShowJump(false)
              bottom.current?.scrollIntoView({ behavior: "smooth" })
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
            回到最新
          </button>
        )}
      </div>

      {/* composer dock */}
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5 pt-1 md:px-6 xl:max-w-[1000px] 2xl:max-w-[1160px]">
        {/* todo dock (opencode): the checklist lives above the composer, not
            in the transcript; progress {done}/{total} with in-progress pulse */}
        {todos.length > 0 && !busy && (
          <div className="dock-tray rise mb-1.5" data-nh-popover>
            <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setDockOpen(!dockOpen)}>
              <span className="tnum rounded-md bg-ok/15 px-1.5 py-0.5 text-[10.5px] font-medium text-ok">
                {todos.filter((t) => t.status === "completed").length}/{todos.length}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{todos.find((t) => t.status === "in_progress")?.content ?? "任务清单"}</span>
              <IconChevron size={12} className={`shrink-0 text-faint transition-transform ${dockOpen ? "rotate-90" : ""}`} />
            </button>
            {dockOpen && (
              <div className="border-t border-line/60 px-2 pb-1.5 pt-0.5">
                {todos.map((t, i) => {
                  const done = t.status === "completed"
                  const now = t.status === "in_progress"
                  return (
                    <div key={i} className={`flex h-8 items-center gap-2.5 rounded-lg px-1.5 text-[12.5px] ${done ? "text-faint" : now ? "text-fg" : "text-dim"}`}>
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {done ? (
                          <span className="flex h-[16px] w-[16px] items-center justify-center rounded-full bg-ok/15 text-ok"><IconCheck size={10} /></span>
                        ) : now ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-warn pulse-dot" />
                        ) : (
                          <IconCircle size={12} className="text-faint" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{t.content}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
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
        <div
          ref={composerBoxRef}
          className="panel-strong composer-solid relative overflow-hidden !rounded-[18px]"
          onDragOver={(e) => {
            if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault()
          }}
          onDrop={(e) => {
            const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"))
            if (files.length > 0) {
              e.preventDefault()
              void addAttachments(files)
            }
          }}
        >
          {/* attachment previews: thumbnail chips with remove, above the toolbar */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2.5">
              {attachments.map((a, i) => (
                <div key={i} className="group relative overflow-hidden rounded-lg border border-line">
                  <img src={`data:${a.mime};base64,${a.data}`} alt={a.name} className="h-12 w-12 object-cover" />
                  <button
                    className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[9px] text-white group-hover:flex"
                    title="移除"
                    onClick={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={composerRef}
            className="nh-grow max-h-44 min-h-[46px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm outline-none placeholder:text-faint"
            rows={1}
            placeholder={busy ? "运行中…输入追问，Enter 插入（Esc 中断）" : "继续对话…输入 / 可唤起命令，可直接粘贴图片"}
            value={input}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"))
              if (files.length === 0) return
              // images-only paste replaces the default; a mixed (text+image)
              // clipboard keeps the text insertion AND attaches the images
              if (!e.clipboardData?.getData("text")) e.preventDefault()
              void addAttachments(files)
            }}
            onChange={(e) => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = "auto"
              el.style.height = Math.min(el.scrollHeight, 176) + "px"
            }}
            onKeyDown={(e) => {
              if (slashTyping && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault()
                setCmdSelected((s) => Math.max(0, Math.min(matchingCommands.length - 1, s + (e.key === "ArrowDown" ? 1 : -1))))
                return
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (slashTyping && matchingCommands[cmdSelected]) {
                  void expandCommand(`/${matchingCommands[cmdSelected]!.name}`)
                  return
                }
                if (!busy && input.startsWith("/")) {
                  // unknown/typed-through command line: the server is
                  // authoritative (404 → toast, never a stray prompt)
                  void expandCommand(input.trim())
                  return
                }
                if (busy) void steer(input)
                else void send()
              }
            }}
          />
          {/* bottom toolbar: left = attach, right = model + permission + send
              (user: the model list belongs on the right, like codex) */}
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                void addAttachments([...(e.target.files ?? [])])
                e.target.value = ""
              }}
            />
            <button className="nh-icon-btn" title="添加图片（也可直接粘贴）" aria-label="添加图片" onClick={() => fileInputRef.current?.click()}>
              <IconPaperclip size={14} />
            </button>
            <span className="flex-1" />
            <ModelPill compact />
            {/* permission level — a real menu, server-durable per session;
                portal'd to <body> so the composer's overflow-hidden never clips it */}
            <button
              className={`pill hover:border-linestrong hover:!text-fg ${policy === "readonly" ? "!border-warn/25 !bg-warn/10 !text-warn" : policy === "trusted" ? "!border-ok/25 !bg-ok/10 !text-ok" : ""}`}
              title="权限分级：本会话生效（写入事件日志）"
              data-nh-popover-anchor
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setPolicyAnchor((a) => (a ? null : { left: r.left, bottom: window.innerHeight - r.top + 6 }))
              }}
              aria-haspopup="menu"
              aria-expanded={!!policyAnchor}
            >
              <IconShield size={10} />
              {policy === "readonly" ? "只读" : policy === "trusted" ? "完全访问" : "默认审批"}
            </button>
            {!busy && (
              <span className="hidden items-center gap-2 text-[10px] text-faint lg:flex">
                <span className="flex items-center gap-1"><kbd className="nh-kbd">Enter</kbd> 发送</span>
              </span>
            )}
            {busy ? (
              <button className="btn-danger flex h-8 w-8 shrink-0 items-center justify-center !rounded-full !p-0" onClick={() => void stop()} aria-label="中断">
                <IconStop size={13} />
              </button>
            ) : (
              <button className="btn-primary h-8 w-8 shrink-0 !rounded-full !p-0" disabled={!input.trim() && attachments.length === 0} onClick={() => void send()} aria-label="发送">
                <IconSend size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      {/* file tree — inside the body row, right of the transcript */}
      {panel === "tree" && <FileTree workspace={localStorage.getItem("NEWHORSE_WORKSPACE") || settings?.workspace} onPick={(p) => setInput((v) => (v ? `${v} ${p}` : p))} onClose={() => setPanel(null)} />}
      {panel === "context" && <ContextPanel events={events} stats={contextStats} systemPrompt={systemPrompt} onClose={() => setPanel(null)} />}
      {panel === "changes" && <FileChanges changes={fileChanges} onClose={() => setPanel(null)} />}
      </div>
      {/* portal'd popovers (composer overflow-hidden can never clip them) */}
      {slashAnchor &&
        createPortal(
          <div className="pop-surface fade fixed z-50 max-h-56 overflow-y-auto rounded-xl border border-linestrong py-1 shadow-modal" style={{ left: slashAnchor.left, bottom: slashAnchor.bottom, width: slashAnchor.width }} data-nh-popover>
            <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">斜杠命令 · Enter 展开到输入框</div>
            {commands.length === 0 && <div className="px-3 py-2 text-xs text-faint">没有可用命令（把 commands/*.md 放进插件目录即可注册）</div>}
            {commands.length > 0 && matchingCommands.length === 0 && <div className="px-3 py-2 text-xs text-faint">没有匹配的命令</div>}
            {matchingCommands.map((c, i) => (
              <button
                key={c.name}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ${i === cmdSelected ? "bg-surface2 text-fg" : "text-dim hover:bg-surface2"}`}
                onMouseEnter={() => setCmdSelected(i)}
                onClick={() => void expandCommand(`/${c.name}`)}
              >
                <span className="font-mono text-accent">/{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-faint">{c.description ?? ""}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
      {policyAnchor &&
        createPortal(
          <div className="pop-surface fade fixed z-50 w-52 rounded-xl border border-linestrong py-1 shadow-modal" style={{ left: policyAnchor.left, bottom: policyAnchor.bottom }} data-nh-popover>
            {([
              { id: "strict", label: "默认审批", desc: "危险操作弹出批准" },
              { id: "readonly", label: "只读 · 计划模式", desc: "只暴露只读工具" },
              { id: "trusted", label: "完全访问", desc: "跳过审批，直执行" },
            ] as const).map((o) => (
              <button key={o.id} className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface2" onClick={() => void changePolicy(o.id)}>
                <span className="mt-0.5 w-3 shrink-0">{policy === o.id ? <IconCheck size={11} className="text-accent" /> : null}</span>
                <span>
                  <span className="block text-[12.5px] text-fg">{o.label}</span>
                  <span className="block text-[10.5px] text-faint">{o.desc}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

/** Single transcript row — document flow (assistant has NO bubble). */
function TurnRow({ t, live, sessionId, showToast, onFork, onRegenerate, hide }: { t: Turn; index: number; live?: boolean; sessionId?: string; showToast?: (msg: string) => void; onFork?: (t: Turn) => void; onRegenerate?: (t: Turn) => void; hide?: boolean }) {
  if (hide) return null
  if (t.kind === "user") {
    return (
      <div className="rise group mb-5 flex justify-end items-start gap-1.5">
        <div className="max-w-[82%]" title={t.ts ? new Date(t.ts).toLocaleString() : undefined}>
          {t.images && t.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
              {t.images.map((img, i) => (
                <a key={i} href={`data:${img.mime};base64,${img.data}`} target="_blank" rel="noreferrer" title="查看原图">
                  <img src={`data:${img.mime};base64,${img.data}`} alt="附件" className="max-h-44 rounded-xl border border-line object-cover transition-transform duration-150 hover:scale-[1.02]" />
                </a>
              ))}
            </div>
          )}
          {t.text && (
            <div className="rounded-xl rounded-br-sm border border-line bg-surface2 px-3 py-1.5 text-[13.5px] whitespace-pre-wrap break-words leading-relaxed text-fg">{t.text}</div>
          )}
        </div>
        {sessionId && onFork && (
          <span className="mt-1 flex shrink-0 flex-col gap-1 text-faint opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100">
            <button className="hover:text-fg" title="复制这条消息" onClick={() => void navigator.clipboard?.writeText(t.text).catch(() => {})}>
              <IconCopy size={12} />
            </button>
            <button className="hover:text-accent" title="回退到这里：分叉新会话，消息回到输入框可改后重发" onClick={() => void onFork(t)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 3v12a3 3 0 0 0 3 3h9M15 6l3 3-3 3"/></svg>
            </button>
            <button className="hover:text-accent" title="重新生成：分叉并原样重发这条消息" onClick={() => void onRegenerate?.(t)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>
            </button>
          </span>
        )}
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
    // memory writes render as a real Context Card (beautifului style): icon
    // chip + clamped content that expands on click; other notes stay pills.
    return t.note === "memory" ? (
      <NoteCard text={t.text} />
    ) : (
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
      <div className="mt-1 flex items-center justify-end gap-2 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100">
        {t.ts && <span className="tnum text-[10.5px] text-faint">{new Date(t.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
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

/** Memory Context Card — a settled memory write shown as its own surface:
 *  icon chip, two-line clamp, click to expand/collapse the full note. */
function NoteCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    // button may contain only phrasing content — the "divs" are styled spans
    <button
      className={`rise mb-3 block w-full text-left transition-colors ${open ? "rounded-xl border border-linestrong bg-surface2/70" : "rounded-xl border border-line bg-surface hover:border-linestrong"}`}
      onClick={() => setOpen((v) => !v)}
      title={open ? "收起" : "展开全文"}
    >
      <span className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-surface2">
          <IconBrain size={12} className="text-faint" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-[0.12em] text-faint">记忆 · 已沉淀到记忆库</span>
          <span className={`block whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-dim ${open ? "" : "line-clamp-2"}`}>{text}</span>
        </span>
        <IconChevron size={12} className={`mt-1 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </span>
    </button>
  )
}
