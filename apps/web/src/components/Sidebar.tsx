import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronsLeft,
  Clock3,
  Cog,
  Database,
  FolderClosed,
  GitBranch,
  Plus,
  Trash2,
  TrendingUp,
} from "lucide-react"
import { api, prettyTitle, relativeTime } from "../api"
import { isActive, useApp, wsName } from "./App"
import { EmotionBall, type BallMood } from "./EmotionBall"
import type { SessionRow } from "../api"

/**
 * Sidebar = the workspace's table of contents. The top block is the
 * workspace identity (name + path + switcher), pinned under it the
 * workspace's resident `newhorse` session — the one stable, always-present
 * conversation — then sessions grouped by workspace, archived tail, and the
 * tool pages footer.
 */

export function Sidebar(): React.ReactElement {
  const { sessions, workspace, setWorkspace, resident, setSidebarOpen } = useApp()
  const navigate = useNavigate()
  const [wsMenu, setWsMenu] = useState(false)

  const workspaces = useMemo(() => {
    const map = new Map<string, SessionRow[]>()
    for (const s of sessions) {
      const list = map.get(s.workspace) ?? []
      list.push(s)
      map.set(s.workspace, list)
    }
    // keep a pinned entry for the current workspace even with zero sessions
    if (workspace && !map.has(workspace)) map.set(workspace, [])
    return [...map.entries()].sort((a, b) => {
      if (a[0] === workspace) return -1
      if (b[0] === workspace) return 1
      const at = Math.max(...a[1].map((s) => s.updatedAt), 0)
      const bt = Math.max(...b[1].map((s) => s.updatedAt), 0)
      return bt - at
    })
  }, [sessions, workspace])

  const brandMood: BallMood = sessions.some(isActive) ? "working" : "idle"

  const openResident = (): void => {
    // Idempotent: the engine derives a stable session id from the workspace,
    // so this returns the same conversation every time.
    api.createSession(undefined, workspace || undefined).then((r) => navigate(`/s/${r.sessionId}`)).catch(() => {})
  }

  const newSession = (): void => {
    api.createSession(undefined, workspace || undefined, false).then((r) => navigate(`/s/${r.sessionId}`)).catch(() => {})
  }

  return (
    <aside className="flex h-full w-[260px] flex-none flex-col border-r border-line bg-side">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <EmotionBall mood={brandMood} size={26} lite />
        <span className="text-base font-semibold tracking-tight">newhorse</span>
        <span className="ml-auto text-2xs font-mono text-ghost">agent engine</span>
        <button className="icon-btn -mr-1.5" title="收起侧栏" onClick={() => setSidebarOpen(false)}>
          <ChevronsLeft size={15} />
        </button>
      </div>

      {/* workspace identity */}
      <div className="px-3 pt-1">
        <div className="relative">
          <button
            className="group flex w-full items-center gap-2.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-linestrong"
            onClick={() => setWsMenu((v) => !v)}
            title={workspace}
          >
            <FolderClosed size={15} className="flex-none text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium leading-tight">{workspace ? wsName(workspace) : "选择工作区"}</span>
              <span className="block truncate font-mono text-2xs text-ghost leading-tight">{workspace || "—"}</span>
            </span>
            <ChevronDown size={13} className={"flex-none text-faint transition-transform " + (wsMenu ? "rotate-180" : "")} />
          </button>
          {wsMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setWsMenu(false)} />
              <div className="menu pop-in absolute left-0 right-0 top-full z-50 mt-1">
                {workspaces.map(([ws]) => (
                  <button
                    key={ws}
                    className={"menu-item " + (ws === workspace ? "text-fg font-medium" : "")}
                    onClick={() => {
                      setWorkspace(ws)
                      setWsMenu(false)
                    }}
                  >
                    <FolderClosed size={13} className="flex-none text-faint" />
                    <span className="min-w-0 flex-1 truncate">{wsName(ws)}</span>
                    {ws === workspace && <span className="font-mono text-2xs text-faint">当前</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* resident newhorse session (pinned) */}
      <div className="px-3 pt-2">
        <div className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-hover">
          <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={openResident} title="打开本工作区的常驻会话">
            <EmotionBall mood={resident && isActive(resident) ? "working" : "idle"} size={20} lite />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm leading-tight">newhorse</span>
              <span className="block truncate font-mono text-2xs text-ghost leading-tight">常驻会话 · {workspace ? wsName(workspace) : "当前工作区"}</span>
            </span>
            {resident && isActive(resident) && <span className="dot dot-active" />}
          </button>
        </div>
        <button className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-faint transition-colors hover:bg-hover hover:text-fg" onClick={newSession}>
          <Plus size={14} />
          新会话
        </button>
      </div>

      {/* sessions grouped by workspace */}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {workspaces.map(([ws, rows]) => (
          <WorkspaceSection key={ws} ws={ws} rows={rows} pinned={ws === workspace} />
        ))}
        <ArchivedTail />
      </div>

      {/* tool pages */}
      <div className="border-t border-line px-3 py-2">
        <div className="grid grid-cols-4 gap-1">
          <FooterNav icon={<TrendingUp size={14} />} label="用量" to="/usage" />
          <FooterNav icon={<Database size={14} />} label="记忆" to="/memory" />
          <FooterNav icon={<Clock3 size={14} />} label="定时" to="/schedules" />
          <FooterNav icon={<Cog size={14} />} label="设置" to="/settings" />
        </div>
      </div>
    </aside>
  )
}

function WorkspaceSection({ ws, rows, pinned }: { ws: string; rows: SessionRow[]; pinned: boolean }): React.ReactElement {
  const [open, setOpen] = useState(true)
  const active = rows.filter((s) => !s.archived && !s.parentId)
  const children = rows.filter((s) => !s.archived && s.parentId)
  if (!active.length && !children.length) {
    return (
      <div className="px-1.5 pb-1 pt-2 font-mono text-2xs text-ghost">
        {wsName(ws)}
        {!pinned && <span className="ml-1.5">· 无会话</span>}
      </div>
    )
  }
  return (
    <div className="pb-1 pt-2">
      <button className="group flex w-full items-center gap-1.5 px-1.5 pb-1" onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={11} className={"text-ghost transition-transform " + (open ? "" : "-rotate-90")} />
        <span className="truncate font-mono text-2xs uppercase tracking-wide text-faint">{wsName(ws)}</span>
        {pinned && <span className="chip chip-accent !px-1.5 !py-0 !text-2xs">当前</span>}
        <span className="ml-auto font-mono text-2xs text-ghost">{active.length}</span>
      </button>
      {open && (
        <>
          {active.map((s) => (
            <SessionLink key={s.sessionId} row={s} />
          ))}
          {children.map((s) => (
            <SessionLink key={s.sessionId} row={s} child />
          ))}
        </>
      )}
    </div>
  )
}

function SessionLink({ row, child }: { row: SessionRow; child?: boolean }): React.ReactElement {
  const navigate = useNavigate()
  const { refreshSessions } = useApp()
  const [armDelete, setArmDelete] = useState(false)
  const active = isActive(row)
  const failed = row.status === "interrupted"
  return (
    <div className={"group flex items-center rounded-md transition-colors hover:bg-hover " + (child ? "pl-6" : "pl-2.5")}>
      <button className="flex min-w-0 flex-1 items-center gap-2 py-[5px] pr-1 text-left" onClick={() => navigate(`/s/${row.sessionId}`)}>
        <span className={"dot " + (active ? "dot-active" : failed ? "dot-error" : "dot-settled")} />
        <span className={"min-w-0 flex-1 truncate text-[13px] leading-tight " + (active ? "text-fg" : "text-dim")}>{prettyTitle(row.title, "未命名会话", 22)}</span>
        <span className="flex-none font-mono text-2xs text-ghost group-hover:hidden">{relativeTime(row.updatedAt)}</span>
      </button>
      <span className="hidden flex-none items-center gap-0.5 pr-1 group-hover:flex">
        {child && <GitBranch size={11} className="text-ghost" />}
        <button
          className="icon-btn !h-5 !w-5"
          title="归档"
          onClick={() => api.archiveSession(row.sessionId).then(refreshSessions).catch(() => {})}
        >
          <Archive size={11} />
        </button>
        <button
          className="icon-btn !h-5 !w-5"
          title={armDelete ? "再点一次确认删除" : "删除"}
          onClick={() => {
            if (!armDelete) return setArmDelete(true)
            api.deleteSession(row.sessionId).then(refreshSessions).catch(() => {})
          }}
        >
          <Trash2 size={11} className={armDelete ? "text-bad" : ""} />
        </button>
      </span>
    </div>
  )
}

function ArchivedTail(): React.ReactElement {
  const { sessions, refreshSessions } = useApp()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const archived = sessions.filter((s) => s.archived)
  if (!archived.length) return <></>
  return (
    <div className="pb-1 pt-2">
      <button className="flex w-full items-center gap-1.5 px-1.5 pb-1" onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={11} className={"text-ghost transition-transform " + (open ? "" : "-rotate-90")} />
        <Archive size={11} className="text-ghost" />
        <span className="font-mono text-2xs uppercase tracking-wide text-faint">已归档</span>
        <span className="ml-auto font-mono text-2xs text-ghost">{archived.length}</span>
      </button>
      {open &&
        archived.map((s) => (
          <div key={s.sessionId} className="group flex items-center rounded-md pl-2.5 transition-colors hover:bg-hover">
            <button className="flex min-w-0 flex-1 items-center gap-2 py-[5px] pr-1 text-left" onClick={() => navigate(`/s/${s.sessionId}`)}>
              <span className="min-w-0 flex-1 truncate text-[13px] text-faint">{prettyTitle(s.title, "未命名会话", 22)}</span>
            </button>
            <span className="hidden flex-none items-center gap-0.5 pr-1 group-hover:flex">
              <button className="icon-btn !h-5 !w-5" title="恢复" onClick={() => api.unarchiveSession(s.sessionId).then(refreshSessions).catch(() => {})}>
                <ArchiveRestore size={11} />
              </button>
              <button
                className="icon-btn !h-5 !w-5"
                title="删除"
                onClick={() => api.deleteSession(s.sessionId).then(refreshSessions).catch(() => {})}
              >
                <Trash2 size={11} />
              </button>
            </span>
          </div>
        ))}
    </div>
  )
}

function FooterNav({ icon, label, to }: { icon: React.ReactNode; label: string; to: string }): React.ReactElement {
  const navigate = useNavigate()
  const location = window.location.hash
  const on = location.startsWith(`#${to}`)
  return (
    <button
      className={"flex flex-col items-center gap-1 rounded-md py-2 text-2xs transition-colors hover:bg-hover hover:text-fg " + (on ? "bg-sel text-fg" : "text-faint")}
      onClick={() => navigate(to)}
    >
      {icon}
      {label}
    </button>
  )
}
