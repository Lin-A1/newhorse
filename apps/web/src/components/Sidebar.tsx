import { useEffect, useMemo, useState } from "react"
import { EmotionBall, type Mood } from "./EmotionBall"
import { useStore, type View } from "../store"
import { api, prettyTitle, relativeTime, type SessionRow } from "../api"
import { cycleTheme, getThemePref, type ThemePref } from "../theme"
import { IconArchive, IconChart, IconCheck, IconChevron, IconClock, IconFolder, IconGear, IconMemory, IconPencil, IconPlus, IconSearch, IconSun, IconMoon, IconMonitor, IconTrash } from "./icons"

/**
 * Sessions-first sidebar. Sessions are PARTITIONED BY WORKSPACE (opencode's
 * project-first IA): each distinct workspace is a collapsible section with a
 * project-name header; inside, sessions sort by recency. A single workspace
 * collapses to the plain recency list (no noise). A workspace header's hover
 * action sets it as the default for NEW sessions; the search spans all groups.
 */
export function Sidebar({ mood, onClose }: { mood: Mood; onClose?: () => void }) {
  const { sessions, settings, refreshSessions, view, setView, showToast, running } = useStore()
  const [archived, setArchived] = useState<SessionRow[]>([])
  const [archOpen, setArchOpen] = useState(false)
  useEffect(() => {
    // the main list is archived-filtered; fetch the full registry for the tail group
    api.sessions().then((rs) => setArchived(rs.filter((r) => r.archived))).catch(() => {})
  }, [sessions])
  const [filter, setFilter] = useState("")
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState("")
  const [themePref, setThemePref] = useState<ThemePref>(getThemePref())

  // Windows paths differ by case and slash direction — normalize before
  // comparing, or a session saved as G:\proj would split from "g:/proj".
  const norm = (p: string): string => p.trim().toLowerCase().replace(/[\\/]+/g, "/").replace(/\/+$/, "")
  const baseName = (p: string): string => {
    const trimmed = p.replace(/[\\/]+$/, "")
    const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
    return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed || "（未知）"
  }

  /** Distinct workspaces, most-recent-activity first; rows inside sort the
   *  same way. `raw` keeps one representative original path (for new-session
   *  defaults and tooltips). */
  const workspaces = useMemo(() => {
    const map = new Map<string, { key: string; raw: string; name: string; rows: SessionRow[] }>()
    for (const r of [...sessions].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))) {
      const key = norm(r.workspace || "")
      const hit = map.get(key)
      if (hit) hit.rows.push(r)
      else map.set(key, { key, raw: r.workspace, name: key ? baseName(r.workspace) : "未分区", rows: [r] })
    }
    return [...map.values()]
  }, [sessions])
  const partitioned = workspaces.length > 1
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const matches = (r: SessionRow, query: string): boolean => (r.title ?? r.sessionId).toLowerCase().includes(query) || baseName(r.workspace).toLowerCase().includes(query)
  const query = filter.trim().toLowerCase()
  const visibleWorkspaces = useMemo(
    () => workspaces.map((w) => ({ ...w, rows: query ? w.rows.filter((r) => matches(r, query)) : w.rows })).filter((w) => w.rows.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, query],
  )
  const defaultWs = norm(localStorage.getItem("NEWHORSE_WORKSPACE") ?? "")
  const setDefaultWs = (raw: string): void => {
    localStorage.setItem("NEWHORSE_WORKSPACE", raw)
    showToast(`新会话默认工作区：${baseName(raw)}`)
    setCollapsed(new Set())
  }

  const go = (v: View): void => {
    setView(v)
    onClose?.()
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
      showToast("已归档")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const unarchive = async (id: string): Promise<void> => {
    try {
      await api.unarchiveSession(id)
      await refreshSessions()
      showToast("已恢复")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  /** Two-step delete: first click arms the row (2.5s), second confirms. */
  const [armDelete, setArmDelete] = useState<string | null>(null)
  const del = async (id: string): Promise<void> => {
    try {
      await api.deleteSession(id)
      setArmDelete(null)
      await refreshSessions()
      if (view.kind === "session" && view.id === id) {
        localStorage.removeItem("NEWHORSE_CURRENT_SESSION")
        go({ kind: "home" })
      }
      showToast("已删除（不可恢复）")
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
      </div>

      <div className="px-2.5 pb-2">
        <div className="relative">
          <IconSearch size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input-base !py-1.5 !pl-8 text-xs" placeholder="搜索会话…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {visibleWorkspaces.map((w) => {
          const open = !collapsed.has(w.key)
          const isDefault = w.key !== "" && w.key === defaultWs
          return (
            <div key={w.key || "(none)"} className="mb-2.5">
              {/* workspace header — always shown; click toggles when partitioned */}
              <button
                className="group flex w-full items-center gap-1.5 rounded-lg px-2 pb-1 pt-1.5 text-left"
                title={w.raw || "会话没有记录工作区"}
                onClick={() => {
                  if (!partitioned) return
                  setCollapsed((c) => {
                    const next = new Set(c)
                    if (next.has(w.key)) next.delete(w.key)
                    else next.add(w.key)
                    return next
                  })
                }}
              >
                {partitioned ? <IconChevron size={10} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} /> : <span className="w-[10px] shrink-0" />}
                <IconFolder size={12} className={`shrink-0 ${isDefault ? "text-accent" : "text-faint"}`} />
                <span className={`min-w-0 flex-1 truncate text-[11px] font-medium ${partitioned ? "text-dim" : "text-faint"}`}>{w.name}</span>
                <span className="tnum shrink-0 text-[10px] text-faint">{w.rows.length}</span>
                {/* hover: set as the default workspace for NEW sessions */}
                <span
                  role="button"
                  className={`shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 ${isDefault ? "text-accent" : "text-faint hover:text-fg"}`}
                  title={isDefault ? "新会话默认工作区" : "设为新会话默认工作区"}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (w.key) setDefaultWs(w.raw)
                    else showToast("该会话没有工作区信息")
                  }}
                >
                  {isDefault ? <IconCheck size={11} /> : <IconPlus size={11} />}
                </span>
              </button>
              {(open || !partitioned) &&
                w.rows.map((r) => {
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
                      <span className={`absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-accent transition-all duration-200 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`} />
                      <div className="flex items-center gap-1.5">
                        {r.role === "butler" && <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-px text-[9px] font-medium text-accent">头马</span>}
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
          )
        })}
        {visibleWorkspaces.length === 0 && (
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

      {/* archived tail group (collapsible) — restore or delete from here */}
      {archived.length > 0 && (
        <div className="mx-2.5 mb-2.5">
          <button className="flex w-full items-center gap-1.5 rounded-lg px-2 pb-1 pt-1 text-left" onClick={() => setArchOpen(!archOpen)}>
            <IconChevron size={10} className={`shrink-0 text-faint transition-transform ${archOpen ? "rotate-90" : ""}`} />
            <IconArchive size={12} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate text-[11px] text-faint">已归档</span>
            <span className="tnum shrink-0 text-[10px] text-faint">{archived.length}</span>
          </button>
          {archOpen &&
            archived.map((r) => (
              <div key={r.sessionId} className="mb-0.5 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-dim">
                <span className="min-w-0 flex-1 truncate text-[12px]">{prettyTitle(r.title, r.sessionId.slice(0, 8))}</span>
                <span role="button" className="shrink-0 rounded p-0.5 text-faint hover:text-fg" title="恢复" onClick={() => void unarchive(r.sessionId)}>
                  <IconArchive size={11} />
                </span>
                <span
                  role="button"
                  className={`shrink-0 rounded p-0.5 ${armDelete === r.sessionId ? "bg-bad/15 text-bad" : "text-faint hover:text-bad"}`}
                  title={armDelete === r.sessionId ? "再次点击确认删除" : "删除"}
                  onClick={() => {
                    if (armDelete === r.sessionId) void del(r.sessionId)
                    else {
                      setArmDelete(r.sessionId)
                      setTimeout(() => setArmDelete((c) => (c === r.sessionId ? null : c)), 2500)
                    }
                  }}
                >
                  <IconTrash size={11} />
                </span>
              </div>
            ))}
        </div>
      )}

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
