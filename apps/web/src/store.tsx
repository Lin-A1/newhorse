import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { api, type SessionRow } from "./api"
import type { EffectiveSettingsView } from "./types"

/**
 * Global client state (kept dependency-free): sessions, effective settings,
 * the active view, the running flag (drives the ball/mood), and a settings
 * reload trigger after writes.
 */
interface Store {
  sessions: SessionRow[]
  refreshSessions: () => Promise<void>
  settings: EffectiveSettingsView | null
  reloadSettings: () => Promise<void>
  view: View
  setView: (v: View) => void
  running: boolean
  setRunning: (r: boolean) => void
  toast: string | null
  showToast: (t: string) => void
}

export type View = { kind: "home" } | { kind: "session"; id: string } | { kind: "usage" } | { kind: "schedules" } | { kind: "memory" }

const Ctx = createContext<Store | null>(null)

export function useStore(): Store {
  const v = useContext(Ctx)
  if (!v) throw new Error("store missing")
  return v
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [settings, setSettings] = useState<EffectiveSettingsView | null>(null)
  const [view, setView] = useState<View>({ kind: "home" })
  const [running, setRunning] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const refreshSessions = useCallback((): Promise<void> => api.sessions().then(setSessions).catch(() => {}), [])
  const reloadSettings = useCallback((): Promise<void> => api.settings().then(setSettings).catch(() => {}), [])

  useEffect(() => {
    void refreshSessions()
    void reloadSettings()
  }, [refreshSessions, reloadSettings])

  const showToast = useCallback((t: string): void => {
    setToast(t)
    setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 2600)
  }, [])

  return <Ctx.Provider value={{ sessions, refreshSessions, settings, reloadSettings, view, setView, running, setRunning, toast, showToast }}>{children}</Ctx.Provider>
}

export function openSession(id: string): void {
  localStorage.setItem(CURRENT_KEY, id)
}
export const CURRENT_KEY = "NEWHORSE_CURRENT_SESSION"

/** Group sessions by recency for the sidebar. */
export function groupSessions(rows: SessionRow[]): Array<{ label: string; rows: SessionRow[] }> {
  const now = Date.now()
  const today0 = new Date().setHours(0, 0, 0, 0)
  const y0 = today0 - 86_400_000
  const w0 = today0 - 6 * 86_400_000
  const groups: Record<string, SessionRow[]> = { 今天: [], 昨天: [], "本周": [], "更早": [] }
  for (const r of rows) {
    const t = r.updatedAt > 1000 ? r.updatedAt : r.createdAt
    if (t >= today0) groups["今天"]!.push(r)
    else if (t >= y0) groups["昨天"]!.push(r)
    else if (t >= w0) groups["本周"]!.push(r)
    else groups["更早"]!.push(r)
  }
  void now
  return Object.entries(groups)
    .filter(([, rs]) => rs.length > 0)
    .map(([label, rs]) => ({ label, rows: rs }))
}
