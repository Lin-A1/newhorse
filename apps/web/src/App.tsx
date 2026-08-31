import { useEffect, useState } from "react"
import { api } from "./api"
import { EmotionBall, type Mood } from "./components/EmotionBall"
import { Sidebar } from "./components/Sidebar"
import { Home } from "./components/Home"
import { SessionView } from "./components/Session"
import { UsagePage, SchedulesPage, MemoryPage } from "./components/Pages"
import { SettingsDialog } from "./components/SettingsDialog"
import { StoreProvider, useStore } from "./store"

function Shell() {
  const { view, setView, running, sessions, refreshSessions, toast } = useStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mood, setMood] = useState<Mood>("idle")

  useEffect(() => {
    const onOpen = (): void => setSettingsOpen(true)
    window.addEventListener("nh-open-settings", onOpen)
    return () => window.removeEventListener("nh-open-settings", onOpen)
  }, [])

  useEffect(() => {
    setMood(running ? "thinking" : "idle")
  }, [running])

  useEffect(() => {
    const onUpdated = (): void => {
      void refreshSessions()
    }
    window.addEventListener("nh-session-updated", onUpdated)
    return () => window.removeEventListener("nh-session-updated", onUpdated)
  }, [refreshSessions])

  // approvals watcher (poll) — drives the badge + opens the dialog
  const [approvals, setApprovals] = useState<Array<{ id: string; kind: string; target: string }>>([])
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      api
        .approvals()
        .then((r) => alive && setApprovals(r.approvals))
        .catch(() => {})
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
  const approval = approvals[0]

  const title = view.kind === "session" ? (sessions.find((s) => s.sessionId === view.id)?.title ?? view.id.slice(0, 8)) : view.kind === "usage" ? "用量统计" : view.kind === "schedules" ? "定时任务" : view.kind === "memory" ? "记忆库" : "newhorse"

  return (
    <div className="flex h-full">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:block md:w-64 md:shrink-0 md:border-r md:border-white/[0.06]">
        <Sidebar mood={mood} />
      </aside>

      {/* Sidebar (mobile drawer) */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="w-72 border-r border-white/[0.08] bg-[#0b0e16]" onClick={() => setSidebarOpen(false)}>
            <Sidebar mood={mood} onClose={() => setSidebarOpen(false)} />
          </div>
          <div className="flex-1 bg-black/60" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex items-center gap-3 border-b border-white/[0.06] bg-black/15 px-4 py-2.5">
          <button className="btn-ghost !p-1.5 md:hidden" onClick={() => setSidebarOpen(true)} aria-label="菜单">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <EmotionBall mood={mood} size={26} />
          <div className="truncate text-[13px] font-medium text-slate-200">{title}</div>
          {approval && (
            <button className="ml-auto rounded-full border border-accent/30 bg-accent/15 px-2.5 py-0.5 text-[11px] text-accent" onClick={() => undefined}>
              {approvals.length} 待审批
            </button>
          )}
        </header>

        {/* Main */}
        <main className="min-h-0 flex-1 overflow-hidden">
          {view.kind === "home" && <Home onCreated={(id) => setView({ kind: "session", id })} />}
          {view.kind === "session" && <SessionView id={view.id} onBack={() => setView({ kind: "home" })} />}
          {view.kind === "usage" && <UsagePage />}
          {view.kind === "schedules" && <SchedulesPage />}
          {view.kind === "memory" && <MemoryPage />}
        </main>
      </div>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {/* approval dialog */}
      {approval && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="nh-rise w-full max-w-md rounded-2xl border border-white/[0.09] bg-[#0e111a] p-5 shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
            <div className="mb-4 flex items-center gap-3">
              <EmotionBall mood="thinking" size={38} />
              <div>
                <div className="text-[14px] font-semibold text-slate-100">需要你的批准</div>
                <div className="text-[11px] text-slate-500">超时将自动拒绝</div>
              </div>
            </div>
            <div className="mb-1.5 text-[11px] text-slate-500">类型：{approval.kind}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-white/[0.05] bg-black/30 p-3 text-sm text-slate-300">{approval.target}</pre>
            <div className="mt-4 flex gap-2">
              <button className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/15 py-2 text-sm font-medium text-red-300 hover:bg-red-500/25" onClick={() => settle(approval.id, false)}>
                拒绝
              </button>
              <button className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500/90 py-2 text-sm font-medium text-ink-950 hover:bg-emerald-400" onClick={() => settle(approval.id, true)}>
                允许
              </button>
            </div>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rise">
          <div className="rounded-xl border border-white/[0.1] bg-[#161a24] px-4 py-2.5 text-[13px] text-slate-200 shadow-[0_16px_44px_rgba(0,0,0,0.5)]">{toast}</div>
        </div>
      )}
    </div>
  )
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
