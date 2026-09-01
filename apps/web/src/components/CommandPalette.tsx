import { useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "../store"
import { api } from "../api"
import { IconButler } from "./icons"

interface Command {
  id: string
  label: string
  hint?: string
  kbd?: string
  action: () => void
}

/** Ctrl+K command palette (opencode signature interaction). Themed via the
 *  design tokens so light mode reads correctly too. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { sessions, settings, setView, refreshSessions, showToast, reloadSettings } = useStore()
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [models, setModels] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 50)
      void api.models().then((r) => setModels(r.models)).catch(() => setModels([]))
    }
  }, [open])

  const newButler = (): void => {
    localStorage.removeItem("NEWHORSE_CURRENT_SESSION")
    const ws = localStorage.getItem("NEWHORSE_WORKSPACE") || settings?.workspace || undefined
    void api
      .createSession(undefined, ws, true)
      .then((r) => {
        localStorage.setItem("NEWHORSE_CURRENT_SESSION", r.sessionId)
        void refreshSessions()
        setView({ kind: "session", id: r.sessionId })
        onClose()
        showToast("newhorse 会话已创建")
      })
      .catch((e) => showToast(e instanceof Error ? e.message : String(e)))
  }

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "new", label: "新会话", hint: "创建并切换", kbd: "Ctrl+N", action: () => { localStorage.removeItem("NEWHORSE_CURRENT_SESSION"); setView({ kind: "home" }); onClose() } },
      { id: "new-butler", label: "新建 newhorse 会话", hint: "固定调度角色 · 可派子代理", action: newButler },
      { id: "usage", label: "用量统计", hint: "热力图与模型分布", action: () => { setView({ kind: "usage" }); onClose() } },
      { id: "schedules", label: "定时任务", hint: "到点发提示词", action: () => { setView({ kind: "schedules" }); onClose() } },
      { id: "memory", label: "记忆库", hint: "语义+关键词检索", action: () => { setView({ kind: "memory" }); onClose() } },
      { id: "settings", label: "设置", hint: "供应商档案/预算/权限/局域网", action: () => { setView({ kind: "settings" }); onClose() } },
    ]
    // provider presets (ccswitch): one entry per profile
    for (const p of settings?.providers ?? []) {
      cmds.push({
        id: `prov-${p.id}`,
        label: `切换供应商 → ${p.name}`,
        hint: p.id === settings?.activeProviderId ? "使用中" : p.model ?? p.kind,
        action: () => {
          api.putSettings({ activeProviderId: p.id }).then(reloadSettings).then(() => showToast(`供应商已切换为 ${p.name}`)).catch(() => showToast("切换失败"))
          onClose()
        },
      })
    }
    // model switch entries
    for (const m of models) {
      cmds.push({ id: `model-${m}`, label: `切换模型 → ${m}`, hint: "新会话生效", action: () => { api.putSettings({ model: m }).then(reloadSettings).then(() => showToast(`已切换为 ${m}`)).catch(() => showToast("切换失败")); onClose() } })
    }
    // session entries
    for (const s of sessions.slice(0, 20)) {
      cmds.push({ id: `sess-${s.sessionId}`, label: (s.role === "butler" ? "[newhorse] " : "") + (s.title || s.sessionId.slice(0, 12)), hint: s.updatedAt > 1000 ? new Date(s.updatedAt).toLocaleString() : "", action: () => { localStorage.setItem("NEWHORSE_CURRENT_SESSION", s.sessionId); setView({ kind: "session", id: s.sessionId }); onClose() } })
    }
    return cmds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, sessions, settings, setView, onClose, reloadSettings, showToast])

  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase()
    return commands.filter((c) => c.label.toLowerCase().includes(q) || (c.hint ?? "").toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => setSelected(0), [query])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); onClose() }
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)) }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)) }
      if (e.key === "Enter" && filtered[selected]) { e.preventDefault(); filtered[selected]!.action() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered, selected, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim pt-[16vh] backdrop-blur-sm" onClick={onClose}>
      <div className="rise w-full max-w-lg overflow-hidden rounded-2xl border border-linestrong bg-surface2 shadow-modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <span className="tnum shrink-0 text-[11px] font-medium text-faint">Ctrl K</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
            placeholder="输入命令或搜索会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="nh-kbd">Esc</kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 && <div className="px-4 py-4 text-[13px] text-faint">没有匹配项</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] transition-colors ${i === selected ? "bg-surface text-fg" : "text-dim hover:bg-surface"}`}
              onClick={() => c.action()}
              onMouseEnter={() => setSelected(i)}
            >
              {c.id === "new-butler" ? <IconButler size={13} className="shrink-0 text-accent" /> : null}
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.hint && <span className="max-w-[180px] truncate text-[11px] text-faint">{c.hint}</span>}
              {c.kbd && <kbd className="nh-kbd shrink-0">{c.kbd}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
