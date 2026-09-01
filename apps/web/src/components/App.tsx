import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { HashRouter, Route, Routes } from "react-router-dom"
import { api, type SessionRow } from "../api"
import { Sidebar } from "./Sidebar"
import { Home } from "./Home"
import { SessionView } from "./Session"
import { SettingsPage } from "./SettingsPage"
import { UsagePage, MemoryPage, SchedulesPage } from "./Pages"
import { CommandPalette } from "./CommandPalette"

/**
 * App shell: hash routing (the runtime server serves this dist as static
 * files; hash routes need no server catch-all), one shared session list
 * polled on a slow cadence for status dots, and the current-workspace
 * identity. The workspace is a first-class UI concept: the sidebar pins the
 * workspace's persistent `newhorse` session and the cover targets it.
 */

interface AppState {
  sessions: SessionRow[]
  refreshSessions: () => void
  workspace: string
  setWorkspace: (ws: string) => void
  /** The persistent per-workspace session row (role butler / stable id), if present. */
  resident: SessionRow | undefined
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
}

const Ctx = createContext<AppState>(null as never)
export const useApp = (): AppState => useContext(Ctx)

/** Workspace basename for display; full path stays in the tooltip. */
export function wsName(ws: string): string {
  const parts = ws.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || ws
}

/** True when the session belongs to an active turn (registry status). */
export function isActive(s: SessionRow): boolean {
  return s.status === "active"
}

export function App(): React.ReactElement {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [workspace, setWorkspaceState] = useState<string>(() => localStorage.getItem("NEWHORSE_WS") ?? "")
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("NEWHORSE_SIDEBAR") !== "0")

  const refreshSessions = useCallback(() => {
    api.sessions().then(setSessions).catch(() => {})
  }, [])

  useEffect(() => {
    refreshSessions()
    const t = setInterval(refreshSessions, 4_000)
    return () => clearInterval(t)
  }, [refreshSessions])

  // Default the workspace from settings until the user picks one explicitly.
  useEffect(() => {
    if (workspace) return
    api.settings().then((s) => {
      if (s.workspace) {
        setWorkspaceState(s.workspace)
        localStorage.setItem("NEWHORSE_WS", s.workspace)
      }
    }).catch(() => {})
  }, [workspace])

  const setWorkspace = useCallback((ws: string) => {
    setWorkspaceState(ws)
    localStorage.setItem("NEWHORSE_WS", ws)
  }, [])

  useEffect(() => {
    localStorage.setItem("NEWHORSE_SIDEBAR", sidebarOpen ? "1" : "0")
  }, [sidebarOpen])

  // The resident session is the workspace's stable, always-available session:
  // the engine derives a deterministic id per workspace, so "open newhorse"
  // never needs to create anything first.
  const resident = useMemo(
    () => sessions.find((s) => s.workspace === workspace && s.role === "butler") ?? sessions.find((s) => s.workspace === workspace && !s.parentId),
    [sessions, workspace],
  )

  const value = useMemo<AppState>(
    () => ({ sessions, refreshSessions, workspace, setWorkspace, resident, sidebarOpen, setSidebarOpen }),
    [sessions, refreshSessions, workspace, setWorkspace, resident, sidebarOpen],
  )

  return (
    <Ctx.Provider value={value}>
      <HashRouter>
        <div className="flex h-full">
          {sidebarOpen && <Sidebar />}
          <ContentFrame />
        </div>
        <CommandPaletteHost />
      </HashRouter>
    </Ctx.Provider>
  )
}

/** Main column: floating global controls, then the routed page. */
function ContentFrame(): React.ReactElement {
  const { sidebarOpen, setSidebarOpen } = useApp()
  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="absolute right-3 top-3 z-30 flex items-center gap-1">
        {!sidebarOpen && (
          <button className="icon-btn" title="打开侧栏" onClick={() => setSidebarOpen(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
        )}
        <button className="icon-btn" title="全局命令 Ctrl+K" onClick={() => window.dispatchEvent(new CustomEvent("nh-palette"))}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="切换主题"
          onClick={() => {
            const next = document.documentElement.dataset.theme === "light" ? "dark" : "light"
            document.documentElement.dataset.theme = next
            document.documentElement.style.colorScheme = next
            localStorage.setItem("NEWHORSE_THEME", next)
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/s/:id" element={<SessionView />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
      </Routes>
    </div>
  )
}

/** Ctrl+K command palette host (mounted once, toggled via window event). */
function CommandPaletteHost(): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onOpen = (): void => setOpen(true)
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("nh-palette", onOpen)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("nh-palette", onOpen)
      window.removeEventListener("keydown", onKey)
    }
  }, [])
  if (!open) return null
  return <CommandPalette onClose={() => setOpen(false)} />
}
