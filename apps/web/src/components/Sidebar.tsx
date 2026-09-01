import { useMemo, useState } from "react"
import { EmotionBall, type Mood } from "./EmotionBall"
import { groupSessions, useStore, type View } from "../store"
import { api, prettyTitle, relativeTime, type SessionRow } from "../api"
import { cycleTheme, getThemePref, type ThemePref } from "../theme"
import { IconArchive, IconChart, IconCheck, IconClock, IconFolder, IconGear, IconMemory, IconPencil, IconPlus, IconSearch, IconSun, IconMoon, IconMonitor, IconX } from "./icons"

/** Sessions-first sidebar (grouped by recency) + utility navigation.
 *  Row hover reveals rename/archive; the workspace chip filters the list and
 *  becomes the default workspace for NEW sessions. */
export function Sidebar({ mood, onClose }: { mood: Mood; onClose?: () => void }) {
  const { sessions, settings, refreshSessions, view, setView, showToast, running } = useStore()
  const [filter, setFilter] = useState("")
  const [workspace, setWorkspace] = useState(() => localStorage.getItem("NEWHORSE_WORKSPACE") ?? "")
  const [wsOpen, setWsOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState("")
  const [themePref, setThemePref] = useState<ThemePref>(getThemePref())

  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const filtered = useMemo(() => {
    // Windows paths differ by case and slash direction — normalize before
    // comparing, or a session saved as G:\proj silently misses filter "g:/proj".
    const norm = (p: string): string => p.trim().toLowerCase().replace(/[\\/]+/g, "/").replace(/\/+$/, "")
    const ws = norm(workspace)
    const byWs = ws ? groups.map((g) => ({ ...g, rows: g.rows.filter((r) => norm(r.workspace) === ws) })).filter((g) => g.rows.length > 0) : groups
    if (!filter.trim()) return byWs
    const q = filter.toLowerCase()
    return byWs.map((g) => ({ ...g, rows: g.rows.filter((r: SessionRow) => (r.title ?? r.sessionId).toLowerCase().includes(q)) })).filter((g) => g.rows.length > 0)
  }, [groups, filter, workspace])

  const go = (v: View): void => {
    setView(v)
    onClose?.()
  }

  const saveWorkspace = (): void => {
    const ws = workspace.trim()
    if (ws) localStorage.setItem("NEWHORSE_WORKSPACE", ws)
    else localStorage.removeItem("NEWHORSE_WORKSPACE")
    setWsOpen(false)
    showToast(ws ? `工作区：${ws}` : "已清除工作区过滤")
  }

  const commitRename = async (id: string): Promise<void> => {
    const title = renameText.trim()
    setRenaming(null)
    if (!title) return
    try {
      await api.setTitle(id, title)
      await refreshSessions()
      showToast("已重命名")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const archive = async (id: string): Promise<void> => {
    try {
      await api.archiveSession(id)
      await refreshSessions()
      showToast("已归档（可在事件日志中恢复）")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const utilities: Array<{ label: string; Icon: typeof IconChart; target: View["kind"] }> = [
    { label: "用量统计", Icon: IconChart, target: "usage" },
    { label: "定时任务", Icon: IconClock, target: "schedules" },
    { label: "记忆库", Icon: IconMemory, target: "memory" },
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <EmotionBall mood={mood} size={34} interactive />
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
          <kbd className="nh-kbd ml-auto opacity-0 transition-opacity group-hover:opacity-100">Ctrl N</kbd>
        </button>
        {/* workspace chip: filters the list + defaults NEW sessions */}
        <button className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-faint transition-colors hover:bg-surface2 hover:text-fg" onClick={() => setWsOpen(!wsOpen)} title="工作区：过滤会话并作为新会话的默认目录">
          <IconFolder size={13} className={workspace.trim() ? "text-accent" : ""} />
          <span className="min-w-0 flex-1 truncate text-left">{workspace.trim() || "全部工作区"}</span>
          {workspace.trim() && (
            <span
              className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-bad group-hover:opacity-70"
              title="清除工作区过滤"
              onClick={(e) => {
                e.stopPropagation()
                setWorkspace("")
                localStorage.removeItem("NEWHORSE_WORKSPACE")
              }}
            >
              <IconX size={11} />
            </span>
          )}
        </button>
        {wsOpen && (
          <div className="pop-in mb-1.5 space-y-1.5 rounded-xl border border-linestrong bg-surface2 p-2 shadow-card" data-nh-popover>
            <input
              className="input-base !py-1.5 font-mono text-[11.5px]"
              placeholder="绝对路径，如 G:\proj（空 = 全部）"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveWorkspace()
                if (e.key === "Escape") setWsOpen(false)
              }}
              autoFocus
            />
            <div className="flex items-center justify-between text-[10.5px] text-faint">
              <span>服务端默认：{settings?.workspace ? settings.workspace.split(/[\\/]/).slice(-1)[0] : "—"}</span>
              <button className="flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-fg hover:border-linestrong" onClick={saveWorkspace}>
                <IconCheck size={10} /> 应用
              </button>
            </div>
          </div>
        )}
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
              if (renaming === r.sessionId) {
                return (
                  <div key={r.sessionId} className="mb-0.5 rounded-lg border border-accent/40 bg-surface2 px-2 py-1.5">
                    <input
                      className="input-base !py-1 text-xs"
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitRename(r.sessionId)
                        if (e.key === "Escape") setRenaming(null)
                      }}
                      autoFocus
                    />
                  </div>
                )
              }
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
                  <div className="flex items-center gap-1.5">
                    {r.role === "butler" && <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-px text-[9px] font-medium text-accent">管家</span>}
                    <span className="min-w-0 flex-1 truncate text-[12.5px] leading-5">{prettyTitle(r.title, r.sessionId.slice(0, 8))}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-faint">
                    <span className={`inline-block h-1 w-1 rounded-full ${r.status === "active" ? "bg-ok shadow-[0_0_5px_rgba(52,211,153,0.8)]" : "bg-faint"}`} />
                    <span className="tnum">{relativeTime(r.updatedAt)}</span>
                    {r.model && <span className="truncate">{r.model.split("/").pop()}</span>}
                    {r.tokensUsed ? <span className="tnum shrink-0">{r.tokensUsed >= 1000 ? `${(r.tokensUsed / 1000).toFixed(1)}k` : r.tokensUsed} tok</span> : null}
                    {/* hover actions — stopPropagation keeps the row unopened */}
                    <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <span
                        role="button"
                        className="rounded p-0.5 hover:text-fg"
                        title="重命名"
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenameText(r.title ?? "")
                          setRenaming(r.sessionId)
                        }}
                      >
                        <IconPencil size={11} />
                      </span>
                      <span
                        role="button"
                        className="rounded p-0.5 hover:text-warn"
                        title="归档"
                        onClick={(e) => {
                          e.stopPropagation()
                          void archive(r.sessionId)
                        }}
                      >
                        <IconArchive size={11} />
                      </span>
                    </span>
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

      {/* getting-started card (opencode): shown while no provider key is set */}
      {settings && !settings.provider.hasApiKey && !(settings.providers ?? []).some((p) => p.hasApiKey) && (
        <div className="mx-2.5 mb-2.5 rounded-xl border border-accent/25 bg-accent/[0.06] p-3">
          <div className="text-[12px] font-medium text-fg">开始使用</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-faint">newhorse 需要一个模型供应商。配置 Key 后即可开始对话，也可以先把常用供应商存成档案一键切换。</div>
          <button
            className="btn-primary mt-2 w-full !py-1.5 !text-[11.5px]"
            onClick={() => {
              go({ kind: "settings" })
              window.dispatchEvent(new CustomEvent("nh-settings-section", { detail: "model" }))
            }}
          >
            连接供应商
          </button>
        </div>
      )}

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
