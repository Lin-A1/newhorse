import { useMemo, useState } from "react"
import { EmotionBall, type Mood } from "./EmotionBall"
import { groupSessions, useStore, type View } from "../store"
import { api, prettyTitle, relativeTime, type SessionRow } from "../api"
import { cycleTheme, getThemePref, type ThemePref } from "../theme"
import { IconChart, IconClock, IconGear, IconMemory, IconPlus, IconSearch, IconSun, IconMoon, IconMonitor } from "./icons"

/** Sessions-first sidebar (grouped by recency) + utility navigation. */
export function Sidebar({ mood, onClose }: { mood: Mood; onClose?: () => void }) {
  const { sessions, view, setView, running } = useStore()
  const [filter, setFilter] = useState("")
  const [themePref, setThemePref] = useState<ThemePref>(getThemePref())
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
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <EmotionBall mood={mood} size={34} />
        <div>
          <div className="text-[14px] font-semibold tracking-tight text-fg">newhorse</div>
          <div className="text-[10.5px] text-faint">agent runtime</div>
        </div>
      </div>

      {/* ZCode-style text action row */}
      <div className="px-2.5 pb-1.5">
        <button
          className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-dim transition-colors hover:bg-surface2 hover:text-fg"
          onClick={() => {
            localStorage.removeItem("NEWHORSE_CURRENT_SESSION")
            go({ kind: "home" })
          }}
        >
          <IconPlus size={15} className="text-faint transition-colors group-hover:text-accent" />
          新会话
          <kbd className="nh-kbd ml-auto opacity-0 transition-opacity group-hover:opacity-100">Enter</kbd>
        </button>
      </div>

      <div className="px-2.5 pb-2">
        <div className="relative">
          <IconSearch size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input-base !py-1.5 !pl-8 text-xs" placeholder="搜索会话…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>


      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {filtered.map((g) => (
          <div key={g.label} className="mb-3">
            <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">{g.label}</div>
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
                  className={`group relative mb-0.5 w-full rounded-lg px-2.5 py-2 text-left transition-all duration-150 ${active ? "bg-surface2 text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" : "text-dim hover:bg-surface2 hover:text-fg"}`}
                >
                  <span className={`absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-gradient-to-b from-accent to-accent-2 transition-all duration-200 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`} />
                  <div className="truncate text-[12.5px] leading-5">{prettyTitle(r.title, r.sessionId.slice(0, 8))}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-faint">
                    <span className={`inline-block h-1 w-1 rounded-full ${r.status === "active" ? "bg-ok shadow-[0_0_5px_rgba(52,211,153,0.8)]" : "bg-faint"}`} />
                    <span className="tnum">{relativeTime(r.updatedAt)}</span>
                    {r.model && <span className="truncate">{r.model.split("/").pop()}</span>}
                  </div>
                </button>
              )
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-4 text-xs leading-relaxed text-faint">
            {sessions.length === 0 ? (
              <>
                还没有会话
                <br />
                在首页描述一个任务即可开始
              </>
            ) : (
              "没有匹配的会话"
            )}
          </div>
        )}
      </div>

      <div className="space-y-0.5 border-t border-line p-2.5">
        {utilities.map(({ label, Icon, target }) => (
          <button
            key={target}
            onClick={() => go({ kind: target } as View)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] transition-all duration-150 ${view.kind === target ? "bg-surface2 text-fg" : "text-dim hover:bg-surface2 hover:text-fg"}`}
          >
            <Icon size={15} className={view.kind === target ? "text-accent" : "opacity-75"} /> {label}
          </button>
        ))}
        <div className="flex items-center justify-between px-2.5 pb-1 pt-2.5 text-[10.5px] text-faint">
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${running ? "bg-ok pulse-dot" : "bg-faint"}`} />
            {running ? "运行中" : "空闲"}
          </span>
          <span className="flex items-center gap-0.5">
            <button
              className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface2 hover:text-fg"
              title={`主题：${themePref === "system" ? "跟随系统" : themePref === "light" ? "浅色" : "深色"}（点击切换）`}
              aria-label="切换主题"
              onClick={() => setThemePref(cycleTheme())}
            >
              {themePref === "system" ? <IconMonitor size={14} /> : themePref === "light" ? <IconSun size={14} /> : <IconMoon size={14} />}
            </button>
            <button
              className={`rounded-md p-1.5 transition-colors hover:bg-surface2 ${view.kind === "settings" ? "text-accent" : "text-faint hover:text-fg"}`}
              title="设置"
              aria-label="设置"
              onClick={() => go({ kind: "settings" })}
            >
              <IconGear size={15} />
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}
