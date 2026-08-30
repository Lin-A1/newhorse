import { HashRouter, Routes, Route, NavLink } from "react-router-dom"
import { useEffect, useState } from "react"
import { ChatPage } from "./components/ChatPage"
import { UsagePage, SchedulesPage } from "./components/Pages"
import { MemoryPage } from "./components/MemoryPage"
import { SettingsPage } from "./components/SettingsPage"
import { EmotionBall, type Mood } from "./components/EmotionBall"
import { api, type SessionRow } from "./api"

/** Global approval watcher: polls pending approvals while any page is open
 *  and renders the settle dialog (the engine auto-denies after 2 minutes). */
function useApprovals(enabled: boolean): { approvals: Array<{ id: string; kind: string; target: string }>; settle: (id: string, allow: boolean) => Promise<void> } {
  const [approvals, setApprovals] = useState<Array<{ id: string; kind: string; target: string }>>([])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = (): void => {
      api
        .approvals()
        .then((r) => alive && setApprovals(r.approvals))
        .catch(() => alive && setApprovals([]))
    }
    tick()
    const t = setInterval(tick, 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [enabled])
  const settle = async (id: string, allow: boolean): Promise<void> => {
    await api.approve(id, allow)
    setApprovals((a) => a.filter((x) => x.id !== id))
  }
  return { approvals, settle }
}

const NAV = [
  { to: "/", label: "会话", icon: "💬" },
  { to: "/usage", label: "用量", icon: "📊" },
  { to: "/schedules", label: "定时", icon: "⏰" },
  { to: "/memory", label: "记忆", icon: "🧠" },
  { to: "/settings", label: "设置", icon: "⚙️" },
]

export function App() {
  const { approvals, settle } = useApprovals(true)
  const [running, setRunning] = useState(false)
  const [sessions, setSessions] = useState<SessionRow[]>([])

  useEffect(() => {
    api.sessions().then(setSessions).catch(() => {})
  }, [])

  const mood: Mood = approvals.length > 0 ? "thinking" : running ? "thinking" : "idle"
  const approval = approvals[0]

  return (
    <HashRouter>
      <div className="flex h-full">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex md:flex-col w-52 shrink-0 border-r border-ink-700 bg-ink-900/60 p-3 gap-1">
          <div className="flex items-center gap-2 px-2 py-3">
            <EmotionBall mood={mood} size={38} />
            <div>
              <div className="font-semibold text-slate-100">newhorse</div>
              <div className="text-xs text-slate-500">agent runtime</div>
            </div>
          </div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded-lg px-3 py-2 text-sm ${isActive ? "bg-ink-700 text-white" : "text-slate-400 hover:bg-ink-800 hover:text-slate-200"}`}>
              {n.icon} {n.label}
            </NavLink>
          ))}
          <div className="mt-auto px-2 text-[11px] text-slate-600">{sessions.length} 个会话 · {running ? "运行中" : "空闲"}</div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          {/* Mobile top bar */}
          <header className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-ink-700 bg-ink-900/60">
            <EmotionBall mood={mood} size={32} />
            <span className="font-semibold">newhorse</span>
            {approval && <span className="ml-auto text-xs rounded-full bg-accent/20 text-accent px-2 py-0.5">{approvals.length} 待审批</span>}
          </header>

          <main className="flex-1 min-h-0 pb-14 md:pb-0">
            <Routes>
              <Route path="/" element={<ChatPage onRunning={setRunning} />} />
              <Route path="/usage" element={<UsagePage />} />
              <Route path="/schedules" element={<SchedulesPage />} />
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </main>

          {/* Mobile bottom nav */}
          <nav className="md:hidden fixed bottom-0 inset-x-0 flex bg-ink-900/95 backdrop-blur border-t border-ink-700">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `flex-1 py-2.5 text-center text-[11px] ${isActive ? "text-accent" : "text-slate-500"}`}>
                <div className="text-base leading-5">{n.icon}</div>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Approval dialog */}
        {approval && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-md rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-5">
              <div className="flex items-center gap-3 mb-3">
                <EmotionBall mood="thinking" size={36} />
                <div className="font-semibold">需要你的批准</div>
              </div>
              <div className="text-xs text-slate-500 mb-1">类型：{approval.kind}</div>
              <pre className="text-sm bg-ink-900 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap break-all">{approval.target}</pre>
              <div className="flex gap-2 mt-4">
                <button className="flex-1 rounded-lg bg-red-500/90 hover:bg-red-500 py-2 text-sm font-medium" onClick={() => settle(approval.id, false)}>
                  拒绝
                </button>
                <button className="flex-1 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 py-2 text-sm font-medium text-ink-950" onClick={() => settle(approval.id, true)}>
                  允许
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </HashRouter>
  )
}
