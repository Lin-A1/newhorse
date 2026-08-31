import { useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "../store"
import { api, type SessionRow } from "../api"

interface Command {
  id: string
  label: string
  hint?: string
  kbd?: string
  action: () => void
}

/** Ctrl+K command palette (opencode signature interaction). */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { sessions, setView, setRunning, refreshSessions, showToast, reloadSettings } = useStore()
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

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "new", label: "新会话", hint: "创建并切换", kbd: "Ctrl+N", action: () => { localStorage.removeItem("NEWHORSE_CURRENT_SESSION"); setView({ kind: "home" }); onClose() } },
      { id: "usage", label: "用量统计", hint: "热力图与模型分布", action: () => { setView({ kind: "usage" }); onClose() } },
      { id: "schedules", label: "定时任务", hint: "到点发提示词", action: () => { setView({ kind: "schedules" }); onClose() } },
      { label: "记忆库", id: "memory", hint: "语义+关键词检索", action: () => { setView({ kind: "memory" }); onClose() } },
      { id: "dag", label: "编排", hint: "DAG 声明式调度", action: () => { setView({ kind: "dag" }); onClose() } },
      { id: "skills", label: "能力", hint: "技能与代理角色", action: () => { setView({ kind: "skills" }); onClose() } },
      { id: "settings", label: "设置", hint: "供应商/预算/权限/局域网", action: () => { setView({ kind: "settings" }); onClose() } },
    ]
    // model switch entries
    for (const m of models) {
      cmds.push({ id: `model-${m}`, label: `切换模型 → ${m}`, hint: "新会话生效", action: () => { api.putSettings({ model: m }).then(reloadSettings).then(() => showToast(`已切换为 ${m}`)).catch(() => showToast("切换失败")); onClose() } })
    }
    // session entries
    for (const s of sessions.slice(0, 20)) {
      cmds.push({ id: `sess-${s.sessionId}`, label: s.title || s.sessionId.slice(0, 12), hint: s.updatedAt > 1000 ? new Date(s.updatedAt).toLocaleString() : "", action: () => { localStorage.setItem("NEWHORSE_CURRENT_SESSION", s.sessionId); setView({ kind: "session", id: s.sessionId }); onClose() } })
    }
    return cmds
  }, [models, sessions, setView, onClose, reloadSettings, showToast])

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
  }, [open, filtered, selected, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[16vh] backdrop-blur-sm" onClick={onClose}>
      <div className="rise w-full max-w-lg rounded-2xl border border-white/[0.1] bg-[#11141d] shadow-[0_24px_64px_rgba(0,0,0,0.6)] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.06]">
          <span className="text-[11px] font-medium text-slate-500 shrink-0">⌘K</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-600 text-slate-200"
            placeholder="输入命令或搜索会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="nh-kbd">Esc</kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 && <div className="px-4 py-4 text-[13px] text-slate-600">没有匹配项</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`w-full flex items-center gap-3 px-4 py-2 text-left text-[13px] transition-colors ${i === selected ? "bg-white/[0.06] text-slate-100" : "text-slate-400 hover:bg-white/[0.03]"}`}
              onClick={() => c.action()}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="flex-1 truncate">{c.label}</span>
              {c.hint && <span className="text-[11px] text-slate-600 truncate max-w-[180px]">{c.hint}</span>}
              {c.kbd && <kbd className="nh-kbd shrink-0">{c.kbd}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
