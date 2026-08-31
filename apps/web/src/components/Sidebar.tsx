import { useMemo, useState } from "react"
import { EmotionBall, type Mood } from "./EmotionBall"
import { groupSessions, useStore, type View } from "../store"
import { api, type SessionRow } from "../api"
import { IconChart, IconClock, IconGear, IconMemory, IconPlus } from "./icons"

/** Sessions-first sidebar (grouped by recency) + utility navigation. */
export function Sidebar({ mood, onClose }: { mood: Mood; onClose?: () => void }) {
  const { sessions, view, setView, running } = useStore()
  const [filter, setFilter] = useState("")
  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const filtered = useMemo(() => {
    if (!filter.trim()) return groups
    const q = filter.toLowerCase()
    return groups.map((g) => ({ ...g, rows: g.rows.filter((r: SessionRow) => (r.title ?? r.sessionId).toLowerCase().includes(q)) })).filter((g) => g.rows.length > 0)
  }, [groups, filter])

  const go = (v: View): void => {
    setView(v)
    onClose?.()
  }

  const utilities: Array<{ label: string; Icon: typeof IconChart; target: View["kind"] }> = [
    { label: "用量统计", Icon: IconChart, target: "usage" },
    { label: "定时任务", Icon: IconClock, target: "schedules" },
    { label: "记忆库", Icon: IconMemory, target: "memory" },
  ]

  return (
    <div className="flex h-full flex-col bg-black/25">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <EmotionBall mood={mood} size={34} />
        <div>
          <div className="text-[14px] font-semibold text-slate-100 tracking-tight">newhorse</div>
          <div className="text-[10.5px] text-slate-500">agent runtime</div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <button
          className="btn-primary w-full py-2 text-[13px]"
          onClick={() => {
            localStorage.removeItem("NEWHORSE_CURRENT_SESSION")
            go({ kind: "home" })
          }}
        >
          <IconPlus size={14} /> 新会话
        </button>
      </div>

      {sessions.length > 3 && (
        <div className="px-3 pb-2">
          <input className="input-base !py-1.5 text-xs" placeholder="搜索会话…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {filtered.map((g) => (
          <div key={g.label} className="mb-3">
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-slate-600">{g.label}</div>
            {g.rows.map((r) => {
              const active = view.kind === "session" && view.id === r.sessionId
              return (
                <button
                  key={r.sessionId}
                  onClick={() => {
                    localStorage.setItem("NEWHORSE_CURRENT_SESSION", r.sessionId)
                    go({ kind: "session", id: r.sessionId })
                    void api.events(r.sessionId).catch(() => {})
                  }}
                  className={`group w-full rounded-lg px-2.5 py-2 text-left transition-colors ${active ? "bg-white/[0.07] text-slate-100" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"}`}
                >
                  <div className="truncate text-[12.5px] leading-5">{r.title || r.sessionId.slice(0, 8)}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-slate-600">
                    <span className={`inline-block h-1 w-1 rounded-full ${r.status === "active" ? "bg-emerald-400" : "bg-slate-700"}`} />
                    {r.updatedAt > 1000 ? new Date(r.updatedAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                    {r.model && <span className="truncate">{r.model}</span>}
                  </div>
                </button>
              )
            })}
          </div>
        ))}
        {filtered.length === 0 && <div className="px-2 py-4 text-xs text-slate-600">没有匹配的会话</div>}
      </div>

      <div className="border-t border-white/[0.06] p-2.5 space-y-0.5">
        {utilities.map(({ label, Icon, target }) => (
          <button
            key={target}
            onClick={() => go({ kind: target } as View)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] transition-colors ${view.kind === target ? "bg-white/[0.07] text-slate-100" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"}`}
          >
            <Icon size={15} className="opacity-75" /> {label}
          </button>
        ))}
        <div className="flex items-center justify-between px-2.5 pb-1 pt-2 text-[10.5px] text-slate-600">
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-400 pulse-dot" : "bg-slate-700"}`} />
            {running ? "运行中" : "空闲"}
          </span>
          <button
            className="text-slate-500 hover:text-slate-200"
            title="设置"
            onClick={() => {
              go({ kind: "home" })
              window.dispatchEvent(new CustomEvent("nh-open-settings"))
            }}
          >
            <IconGear size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
