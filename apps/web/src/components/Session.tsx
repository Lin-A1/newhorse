import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { ChevronDown, ChevronRight, CircleStop, Paperclip, Shield, SquarePen, X } from "lucide-react"
import { api, foldFileChanges, foldTranscript, prettyTitle, relativeTime, type FileChange, type StoredEventRow } from "../api"
import { useApp } from "./App"
import { EmotionBall, type BallMood } from "./EmotionBall"
import { Markdown } from "./Markdown"

/**
 * Session view: the transcript is folded from the durable event log (the
 * same source the model sees — no client-side side channel), live deltas
 * stream over the prompt SSE, and the todo dock sits above the composer
 * (out of the transcript, opencode-style). The ball in the header is this
 * session's avatar and mirrors the turn's working state.
 */

type FoldedRow = ReturnType<typeof foldTranscript>[number]

interface Approval {
  id: string
  kind: string
  target: string
  createdAt: number
}

export function SessionView(): React.ReactElement {
  const { id = "" } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { refreshSessions, sessions } = useApp()

  const [events, setEvents] = useState<StoredEventRow[]>([])
  const [live, setLive] = useState<{ text: string; mood: BallMood } | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState("")
  const [policy, setPolicy] = useState<"strict" | "readonly" | "trusted">("strict")
  const [policyOpen, setPolicyOpen] = useState(false)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [todos, setTodos] = useState<Array<{ content: string; status: string }>>([])
  const [todosOpen, setTodosOpen] = useState(true)
  const [showChanges, setShowChanges] = useState(false)
  const [text, setText] = useState("")
  const [images, setImages] = useState<Array<{ mime: string; data: string; url: string }>>([])
  const sentRef = useRef(false)

  const row = useMemo(() => sessions.find((s) => s.sessionId === id), [sessions, id])
  const rows = useMemo(() => foldTranscript(events), [events])
  const changes = useMemo(() => foldFileChanges(events), [events])
  const transcribing = streaming || row?.status === "active"

  const reload = useCallback(() => {
    api.events(id).then(setEvents).catch(() => {})
  }, [id])

  useEffect(() => {
    reload()
    api.policy(id).then((p) => setPolicy(p.policy)).catch(() => {})
  }, [id, reload])

  // poll while the session is mid-turn; slow otherwise (sidebar cadence covers it)
  useEffect(() => {
    if (!transcribing) return
    const t = setInterval(() => {
      reload()
      api.approvals().then((r) => setApprovals(r.approvals)).catch(() => {})
    }, 1_500)
    return () => clearInterval(t)
  }, [transcribing, reload, id])

  const promptOnce = useCallback(
    (body: string, imgs?: Array<{ mime: string; data: string }>): void => {
      if (!body.trim() && !imgs?.length) return
      setError("")
      setStreaming(true)
      setLive({ text: "", mood: "thinking" })
      const moodByEvent = (t: string): BallMood =>
        t === "tool" ? "searching" : t === "text" ? "replying" : t === "reasoning" ? "thinking" : "working"
      api
        .prompt(
          id,
          body,
          (e) => {
            const t = String(e.type ?? "")
            if (t === "text" || t === "reasoning") {
              const piece = String((e as { text?: string }).text ?? "")
              setLive((v) => (t === "text" ? { text: (v?.text ?? "") + piece, mood: "replying" } : { text: v?.text ?? "", mood: "thinking" }))
            } else if (t === "tool" || t === "tool-result" || t === "step") {
              setLive((v) => ({ text: v?.text ?? "", mood: moodByEvent(t) }))
            } else if (t === "error") {
              setError(String((e as { message?: string }).message ?? "出错了"))
              setLive((v) => ({ text: v?.text ?? "", mood: "error" }))
            } else if (t === "done") {
              setLive((v) => ({ text: v?.text ?? "", mood: "done" }))
            }
          },
          undefined,
          imgs,
        )
        .then((r) => {
          if (r.error) setError(r.error)
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          setStreaming(false)
          setLive(null)
          reload()
          refreshSessions()
        })
    },
    [id, reload, refreshSessions],
  )

  // cover hand-off: location.state carries { prompt, images } exactly once
  useEffect(() => {
    if (sentRef.current) return
    const state = location.state as { prompt?: string; images?: Array<{ mime: string; data: string }> } | null
    if (state?.prompt || state?.images?.length) {
      sentRef.current = true
      navigate(location.pathname, { replace: true, state: null })
      promptOnce(state.prompt ?? "", state.images)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const send = (): void => {
    const t = text.trim()
    const imgs = images.map(({ mime, data }) => ({ mime, data }))
    setText("")
    setImages([])
    if (transcribing) {
      // mid-turn input is admitted as a durable steer, never dropped
      api.steer(id, t).then(() => reload()).catch(() => {})
      return
    }
    promptOnce(t, imgs.length ? imgs : undefined)
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue
      const buf = await f.arrayBuffer()
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      setImages((v) => [...v, { mime: f.type, data: b64, url: `data:${f.type};base64,${b64}` }])
    }
  }

  const lastTodoRow = [...rows].reverse().find((r) => r.kind === "todo")

  useEffect(() => {
    if (!lastTodoRow) return setTodos([])
    const parsed = lastTodoRow.text
      .split("\n")
      .map((l) => {
        const m = l.match(/^\[(done|now|\s)\]\s*(.*)$/)
        return m ? { status: m[1] === "done" ? "completed" : m[1] === "now" ? "in_progress" : "pending", content: m[2] ?? "" } : null
      })
      .filter((x) => x !== null) as Array<{ content: string; status: string }>
    setTodos(parsed)
  }, [lastTodoRow])

  const mood: BallMood = live?.mood ?? (error ? "error" : row?.status === "active" ? "working" : "listening")

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* header */}
      <header className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line bg-panel px-4">
        <EmotionBall mood={mood} size={24} lite />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium leading-tight">{prettyTitle(row?.title, "会话", 34)}</div>
          <div className="font-mono text-2xs text-ghost leading-tight">{relativeTime(row?.updatedAt ?? 0)}{row?.model ? ` · ${row.model}` : ""}</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button className="chip cursor-pointer hover:border-linestrong hover:text-fg" onClick={() => setShowChanges((v) => !v)} title="本会话文件改动">
            改动 {changes.length}
          </button>
          <div className="relative">
            <button className="chip cursor-pointer hover:border-linestrong hover:text-fg" onClick={() => setPolicyOpen((v) => !v)}>
              <Shield size={11} />
              {policy}
            </button>
            {policyOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setPolicyOpen(false)} />
                <div className="menu pop-in absolute right-0 top-full z-50 mt-1">
                  {(["strict", "readonly", "trusted"] as const).map((p) => (
                    <button
                      key={p}
                      className={"menu-item " + (p === policy ? "text-fg font-medium" : "")}
                      onClick={() => {
                        api.setPolicy(id, p).then(() => setPolicy(p)).catch(() => {})
                        setPolicyOpen(false)
                      }}
                    >
                      {p}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <div className="px-2 py-1 text-2xs leading-relaxed text-faint">
                    strict: 每个写入动作都要批准 · readonly: 只读 · trusted: 自动放行
                  </div>
                </div>
              </>
            )}
          </div>
          {transcribing ? (
            <button className="btn btn-danger" onClick={() => api.interrupt(id).then(refreshSessions).catch(() => {})}>
              <CircleStop size={12} />
              中断
            </button>
          ) : (
            <button className="btn" onClick={() => api.forkSession(id).then((r) => navigate(`/s/${r.sessionId}`)).catch(() => {})}>
              <SquarePen size={12} />
              分叉
            </button>
          )}
        </div>
      </header>

      {/* file changes drawer */}
      {showChanges && <ChangesDrawer changes={changes} onClose={() => setShowChanges(false)} />}

      {/* transcript */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-[760px]">
          {rows.length === 0 && !live && <EmptyState />}
          {rows.map((r, i) => (
            <Row key={i} row={r} forkSeq={r.kind === "user" ? r.seq : undefined} onFork={(seq) => api.forkSession(id, seq).then((f) => navigate(`/s/${f.sessionId}`)).catch(() => {})} />
          ))}
          {live && (live.text || live.mood === "thinking" || live.mood === "working" || live.mood === "searching") && (
            <div className="fade-up mb-5 flex gap-3">
              <Marker color="var(--traj-assistant)" />
              <div className="min-w-0 flex-1">
                {live.text ? <Markdown text={live.text} streaming /> : <ThinkingLine mood={live.mood} />}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* approvals + todo dock + composer */}
      <div className="flex-none px-4 pb-4">
        <div className="mx-auto max-w-[760px]">
          {error && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-card px-3.5 py-2.5 text-sm" style={{ borderColor: "var(--bad)" }}>
              <span className="dot dot-error" />
              <span className="min-w-0 flex-1 truncate text-dim">{error}</span>
              <button className="icon-btn !h-5 !w-5" onClick={() => setError("")}>
                <X size={12} />
              </button>
            </div>
          )}
          {approvals.map((a) => (
            <div key={a.id} className="mb-2 flex items-center gap-3 rounded-lg border border-line bg-card px-3.5 py-2.5">
              <span className="dot dot-active" style={{ background: "var(--warn)" }} />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                <span className="font-mono text-2xs text-warn">{a.kind}</span>
                <span className="mx-2 text-ghost">·</span>
                <span className="font-mono text-2xs text-dim">{a.target}</span>
              </span>
              <button className="btn btn-primary" onClick={() => api.approve(a.id, true).then(() => setApprovals((v) => v.filter((x) => x.id !== a.id))).catch(() => {})}>
                允许
              </button>
              <button className="btn" onClick={() => api.approve(a.id, false).then(() => setApprovals((v) => v.filter((x) => x.id !== a.id))).catch(() => {})}>
                拒绝
              </button>
            </div>
          ))}
          {todos.length > 0 && <TodoDock todos={todos} open={todosOpen} setOpen={setTodosOpen} />}
          <div className="composer">
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3.5 pt-3">
                {images.map((img, i) => (
                  <div key={i} className="group relative h-14 w-14 overflow-hidden rounded-md border border-line">
                    <img src={img.url} className="h-full w-full object-cover" alt="" />
                    <button
                      className="absolute inset-y-0 right-0 hidden items-center justify-center bg-black/55 text-white group-hover:flex"
                      onClick={() => setImages((v) => v.filter((_, j) => j !== i))}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={text}
              rows={1}
              style={{ minHeight: 44, maxHeight: 200 }}
              placeholder={transcribing ? "会话进行中,输入会作为追加指令排队…" : "输入任务,Enter 发送,Shift+Enter 换行"}
              onChange={(e) => setText(e.target.value)}
              onInput={(e) => {
                const el = e.currentTarget
                el.style.height = "auto"
                el.style.height = Math.min(el.scrollHeight, 200) + "px"
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile() as File)
                if (files.length) void addFiles(files)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                id="session-image-input"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files)
                  e.target.value = ""
                }}
              />
              <label htmlFor="session-image-input" className="icon-btn !h-7 !w-7 cursor-pointer" title="附加图片">
                <Paperclip size={14} />
              </label>
              <div className="ml-auto flex items-center gap-2">
                <span className="chip !py-0.5">{policy}</span>
                <button className="send-btn" disabled={(!text.trim() && !images.length) || streaming} onClick={send}>
                  {transcribing ? <span className="spin inline-block h-3.5 w-3.5 rounded-full border-[1.5px] border-current border-t-transparent" /> : <ArrowUpIcon />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- pieces ---------- */

function ArrowUpIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}

function Marker({ color }: { color: string }): React.ReactElement {
  return <span className="traj-tag" style={{ background: color, opacity: 0.55 }} />
}

function EmptyState(): React.ReactElement {
  return (
    <div className="flex flex-col items-center pt-[16vh] text-center">
      <EmotionBall mood="idle" size={72} />
      <p className="mt-4 text-sm text-faint">这个会话还没有内容,发第一条消息开始。</p>
    </div>
  )
}

function ThinkingLine({ mood }: { mood: BallMood }): React.ReactElement {
  const label = mood === "searching" ? "正在检索" : mood === "thinking" ? "思考中" : "工作中"
  return (
    <div className="flex items-center gap-2 text-sm text-faint">
      <span className="spin inline-block h-3 w-3 rounded-full border-[1.5px] border-current border-t-transparent" />
      {label}…
    </div>
  )
}

function Row({ row, forkSeq, onFork }: { row: FoldedRow; forkSeq?: number; onFork: (seq: number) => void }): React.ReactElement {
  const [open, setOpen] = useState(false)
  if (row.kind === "user") {
    return (
      <div className="group mb-6 flex gap-3">
        <Marker color="var(--traj-user)" />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap text-[14.5px] leading-relaxed">{row.text}</div>
          {row.images && row.images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {row.images.map((img, i) => (
                <img key={i} src={`data:${img.mime};base64,${img.data}`} className="max-h-40 rounded-lg border border-line" alt="" />
              ))}
            </div>
          )}
          {forkSeq !== undefined && (
            <div className="mt-1.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button className="font-mono text-2xs text-ghost hover:text-fg" onClick={() => onFork(forkSeq)}>
                从这条消息重新分叉 →
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }
  if (row.kind === "assistant") {
    return (
      <div className="mb-6 flex gap-3">
        <Marker color="var(--traj-assistant)" />
        <div className="min-w-0 flex-1">
          <Markdown text={row.text} />
        </div>
      </div>
    )
  }
  if (row.kind === "thinking") {
    return (
      <div className="mb-4 flex gap-3">
        <Marker color="var(--traj-reasoning)" />
        <div className="min-w-0 flex-1">
          <button className="flex items-center gap-1 font-mono text-2xs uppercase tracking-wide text-faint hover:text-dim" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            推理过程
          </button>
          {open && <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3 text-[13px] italic leading-relaxed text-faint">{row.text}</div>}
        </div>
      </div>
    )
  }
  if (row.kind === "tool") {
    const isErr = "isError" in row && row.isError
    return (
      <div className="mb-2.5 flex gap-3">
        <Marker color="var(--traj-tool)" />
        <div className="min-w-0 flex-1">
          <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover" onClick={() => setOpen((v) => !v)}>
            <span className="chip !py-0.5" style={isErr ? { color: "var(--bad)", borderColor: "var(--bad)" } : {}}>
              {row.toolName ?? "tool"}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-faint">{firstLine(row.text)}</span>
            {open ? <ChevronDown size={12} className="flex-none text-ghost" /> : <ChevronRight size={12} className="flex-none text-ghost" />}
          </button>
          {open && (
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg2 p-3 font-mono text-2xs leading-relaxed text-dim">{row.text || "(无输出)"}</pre>
          )}
        </div>
      </div>
    )
  }
  if (row.kind === "todo") return <></> // rendered by the dock above the composer
  // notes: 中断 / 压缩 / 记忆
  return (
    <div className="mb-4 flex items-center gap-2 pl-5 text-2xs text-ghost">
      <span className="h-px w-4 bg-line-strong" />
      {row.note === "memory" ? "已记住: " : ""}
      {row.text}
    </div>
  )
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? ""
  return line.length > 90 ? line.slice(0, 90) + "…" : line
}

function TodoDock({ todos, open, setOpen }: { todos: Array<{ content: string; status: string }>; open: boolean; setOpen: (v: boolean) => void }): React.ReactElement {
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <div className="mb-2 rounded-lg border border-line bg-card">
      <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left" onClick={() => setOpen(!open)}>
        <span className="font-mono text-2xs uppercase tracking-wide text-faint">todo</span>
        <span className="font-mono text-2xs text-dim">
          {done}/{todos.length}
        </span>
        <span className="h-1 w-16 overflow-hidden rounded-full bg-hover-2">
          <span className="block h-full rounded-full bg-ok" style={{ width: `${todos.length ? (done / todos.length) * 100 : 0}%` }} />
        </span>
        <span className="ml-auto text-ghost">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      </button>
      {open && (
        <div className="border-t border-line px-3.5 py-2">
          {todos.map((t, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5 text-[13px]">
              <span
                className="mt-[5px] flex-none"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: t.status === "completed" ? "var(--ok)" : t.status === "in_progress" ? "var(--warn)" : "var(--hover-2)",
                }}
              />
              <span className={"leading-snug " + (t.status === "completed" ? "text-ghost line-through" : t.status === "in_progress" ? "text-fg" : "text-dim")}>{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChangesDrawer({ changes, onClose }: { changes: FileChange[]; onClose: () => void }): React.ReactElement {
  return (
    <div className="flex-none border-b border-line bg-bg2 px-4 py-3">
      <div className="mx-auto max-w-[760px]">
        <div className="mb-2 flex items-center gap-2">
          <span className="label">本会话文件改动</span>
          <span className="h-px flex-1 bg-line" />
          <button className="icon-btn !h-5 !w-5" onClick={onClose}>
            <X size={12} />
          </button>
        </div>
        {changes.length === 0 && <p className="text-2xs text-ghost">还没有文件写入或编辑。</p>}
        <div className="space-y-1.5">
          {changes.map((c) => (
            <details key={c.path} className="rounded-md border border-line bg-panel">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-2xs">
                <span className="min-w-0 flex-1 truncate">{c.path}</span>
                <span className="text-ok">+{c.added}</span>
                <span className="text-bad">−{c.removed}</span>
                <span className="text-ghost">×{c.touches}</span>
              </summary>
              <div className="codeblock-body border-t border-line">
                {c.diff.map((d, i) => (
                  <div key={i} className={"cline " + (d.kind === "add" ? "add" : d.kind === "del" ? "del" : "")}>
                    <span className="ln" />
                    <span>{d.text || " "}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  )
}
