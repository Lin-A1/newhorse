import { HashRouter, Routes, Route, NavLink } from "react-router-dom"
import { useEffect, useState } from "react"
import { ChatPage } from "./components/ChatPage"
import { UsagePage, SchedulesPage } from "./components/Pages"
import { MemoryPage } from "./components/MemoryPage"
import { SettingsPage } from "./components/SettingsPage"
import { EmotionBall, type Mood } from "./components/EmotionBall"
import { IconChat, IconChart, IconClock, IconMemory, IconGear, IconCheck, IconX } from "./components/icons"
import { api, type SessionRow } from "./api"

/** Global approval watcher: polls pending approvals while any page is open
 *  and renders the settle dialog (the engine auto-denies after 2 minutes). */
function useApprovals(): { approvals: Array<{ id: string; kind: string; target: string }>; settle: (id: string, allow: boolean) => Promise<void> } {
  const [approvals, setApprovals] = useState<Array<{ id: string; kind: string; target: string }>>([])
  useEffect(() => {
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
  }, [])
  const settle = async (id: string, allow: boolean): Promise<void> => {
    await api.approve(id, allow)
    setApprovals((a) => a.filter((x) => x.id !== id))
  }
  return { approvals, settle }
}

const NAV = [
  { to: "/", label: "会话", Icon: IconChat },
  { to: "/usage", label: "用量", Icon: IconChart },
  { to: "/schedules", label: "定时", Icon: IconClock },
  { to: "/memory", label: "记忆", Icon: IconMemory },
  { to: "/settings", label: "设置", Icon: IconGear },
]

export function App() {
  const { approvals, settle } = useApprovals()
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
        <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-white/[0.06] bg-black/20 p-3 gap-1">
          <div className="flex items-center gap-2.5 px-2 py-4">
            <EmotionBall mood={mood} size={42} />
            <div>
              <div className="font-semibold text-slate-100 tracking-tight">newhorse</div>
              <div className="text-[11px] text-slate-500">agent runtime</div>
            </div>
          </div>
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
                  isActive ? "bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                }`
              }
            >
              <Icon size={17} className="opacity-80" />
              {label}
            </NavLink>
          ))}
          <div className="mt-auto px-3 pb-1 text-[11px] text-slate-600 flex items-center gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-400 nh-pulse" : "bg-slate-600"}`} />
            {running ? "运行中" : "空闲"} · {sessions.length} 会话
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          {/* Mobile top bar */}
          <header className="md:hidden flex items-center gap-2.5 px-3 py-2.5 border-b border-white/[0.06] bg-black/25">
            <EmotionBall mood={mood} size={30} />
            <span className="font-semibold tracking-tight">newhorse</span>
            {approval && (
              <span className="ml-auto text-[11px] rounded-full bg-accent/15 text-accent px-2 py-0.5 border border-accent/25">
                {approvals.length} 待审批
              </span>
            )}
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
          <nav className="md:hidden fixed bottom-0 inset-x-0 flex bg-black/40 backdrop-blur-md border-t border-white/[0.06]">
            {NAV.map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} className={({ isActive }) => `flex-1 py-2 text-center text-[10px] ${isActive ? "text-accent" : "text-slate-500"}`}>
                <Icon size={17} className="mx-auto mb-0.5" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Approval dialog */}
        {approval && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md nh-card bg-ink-800/90 p-5 nh-rise">
              <div className="flex items-center gap-3 mb-4">
                <EmotionBall mood="thinking" size={38} />
                <div>
                  <div className="font-semibold text-slate-100">需要你的批准</div>
                  <div className="text-[11px] text-slate-500">超时将自动拒绝</div>
                </div>
              </div>
              <div className="text-[11px] text-slate-500 mb-1.5">类型：{approval.kind}</div>
              <pre className="text-sm bg-black/30 rounded-xl p-3 overflow-auto max-h-40 whitespace-pre-wrap break-all border border-white/[0.05]">{approval.target}</pre>
              <div className="flex gap-2 mt-4">
                <button className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 py-2 text-sm font-medium text-red-300" onClick={() => settle(approval.id, false)}>
                  <IconX size={14} /> 拒绝
                </button>
                <button className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500/90 hover:bg-emerald-400 py-2 text-sm font-medium text-ink-950" onClick={() => settle(approval.id, true)}>
                  <IconCheck size={14} /> 允许
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </HashRouter>
  )
}
