import { useEffect, useState } from "react"
import { prettyTitle } from "./api"
import { EmotionBall } from "./components/EmotionBall"
import { Sidebar } from "./components/Sidebar"
import { Home } from "./components/Home"
import { SessionView } from "./components/Session"
import { UsagePage, SchedulesPage, MemoryPage } from "./components/Pages"
import { SettingsPage } from "./components/SettingsPage"
import { CommandPalette } from "./components/CommandPalette"
import { StoreProvider, useStore } from "./store"
import { IconGear, IconTarget } from "./components/icons"

function fmtElapsed(sec: number): string {
  const s = Math.floor(sec)
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

const VIEW_TITLES: Record<string, string> = { home: "newhorse", usage: "用量统计", schedules: "定时任务", memory: "记忆库", settings: "设置" }

function Shell() {
  const { view, setView, sessions, refreshSessions, toast, mood, sessionBusy, sessionElapsed, approvals, settleApproval } = useStore()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // desktop sidebar can be hidden too (Ctrl+B) — opencode/codex both allow it
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // legacy dispatchers (error tray, memory CTA) route to the settings page
  useEffect(() => {
    const onOpen = (): void => setView({ kind: "settings" })
    window.addEventListener("nh-open-settings", onOpen)
    return () => window.removeEventListener("nh-open-settings", onOpen)
  }, [setView])

  // opencode-style keybinds: Ctrl+K palette, Ctrl+N new session, Ctrl+B sidebar
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === "k") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (k === "n") {
        e.preventDefault()
        localStorage.removeItem("NEWHORSE_CURRENT_SESSION")
        setView({ kind: "home" })
      } else if (k === "b") {
        e.preventDefault()
        setSidebarHidden((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setView])

  useEffect(() => {
    const onUpdated = (): void => {
      void refreshSessions()
    }
    window.addEventListener("nh-session-updated", onUpdated)
    return () => window.removeEventListener("nh-session-updated", onUpdated)
  }, [refreshSessions])

  const approval = approvals[0]

  const title =
    view.kind === "session" ? prettyTitle(sessions.find((s) => s.sessionId === view.id)?.title, view.id.slice(0, 8)) : (VIEW_TITLES[view.kind] ?? "newhorse")

  return (
    <div className="relative z-10 flex h-full">
      {/* Sidebar (desktop; Ctrl+B hides) */}
      {!sidebarHidden && (
        <aside className="hidden w-64 shrink-0 border-r border-line bg-chrome md:block">
          <Sidebar mood={mood} />
        </aside>
      )}

      {/* Sidebar (mobile drawer) — only the backdrop dismisses; inner clicks survive */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="pop-in h-full w-72 shrink-0 border-r border-line bg-surface2 shadow-2xl">
            <Sidebar mood={mood} onClose={() => setDrawerOpen(false)} />
          </div>
          <div className="fade flex-1 bg-scrim backdrop-blur-[2px]" onClick={() => setDrawerOpen(false)} />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Global top bar */}
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-chrome px-4 backdrop-blur-md">
          <button className="btn-ghost !rounded-lg !p-1.5 md:hidden" onClick={() => setDrawerOpen(true)} aria-label="菜单">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <EmotionBall mood={mood} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-tight text-fg">{title}</div>
          </div>
          {view.kind === "session" && (
            <div className="pill tnum">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${sessionBusy ? "bg-ok pulse-dot" : mood === "error" ? "bg-bad" : "bg-faint"}`} />
              {sessionBusy ? `工作中 ${fmtElapsed(sessionElapsed)}` : mood === "error" ? "出错了" : "就绪"}
            </div>
          )}
          {approvals.length > 0 && (
            <div className="pill !border-warn/30 !bg-warn/10 !text-warn tnum">
              <IconTarget size={12} />
              {approvals.length} 待审批
            </div>
          )}
          <button className={`btn-ghost !rounded-lg !p-2 ${paletteOpen ? "!border-accent/40 !text-accent" : ""}`} onClick={() => setPaletteOpen(true)} aria-label="命令面板" title="Ctrl+K">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>
          </button>
          <button className={`btn-ghost !rounded-lg !p-2 ${view.kind === "settings" ? "!border-accent/40 !text-accent" : ""}`} onClick={() => setView({ kind: "settings" })} aria-label="设置">
            <IconGear size={15} />
          </button>
        </header>

        {/* Main */}
        <main className="min-h-0 flex-1 overflow-hidden">
          {view.kind === "home" && <Home onCreated={(id) => setView({ kind: "session", id })} />}
          {view.kind === "session" && <SessionView id={view.id} />}
          {view.kind === "usage" && <UsagePage />}
          {view.kind === "schedules" && <SchedulesPage />}
          {view.kind === "memory" && <MemoryPage />}
          {view.kind === "settings" && <SettingsPage />}

        </main>
      </div>

      {/* approval dialog — only outside a session; in-session approvals render
          as a dock tray fused to the composer (see Session.tsx) */}
      {approval && view.kind !== "session" && (
        <div className="fade fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="需要你的批准">
          <div className="pop-in w-full max-w-md rounded-2xl border border-linestrong bg-surface2 p-5 shadow-modal">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-xl border border-warn/25 bg-warn/10 p-1.5">
                <IconTarget size={18} className="text-warn" />
              </div>
              <div>
                <div className="text-[14px] font-semibold text-fg">需要你的批准</div>
                <div className="text-[11px] text-faint">超时将自动拒绝</div>
              </div>
            </div>
            <div className="mb-1.5 text-[11px] uppercase tracking-wider text-faint">类型 · {approval.kind}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-inset p-3 text-[12.5px] leading-relaxed text-dim">{approval.target}</pre>
            <div className="mt-4 flex gap-2">
              <button className="btn-danger flex-1 !py-2" onClick={() => void settleApproval(approval.id, false)}>
                拒绝
              </button>
              <button className="btn-ok flex-1 !py-2" onClick={() => void settleApproval(approval.id, true)}>
                允许
              </button>
            </div>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2" role="status" aria-live="polite">
          <div className="pop-in rounded-xl border border-linestrong bg-surface2/95 px-4 py-2.5 text-[13px] text-fg shadow-modal backdrop-blur">{toast}</div>
        </div>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
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
