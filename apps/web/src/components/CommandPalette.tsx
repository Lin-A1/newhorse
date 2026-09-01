import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowRight, Cog, Database, FolderClosed, MessageSquare, Plus, Timer, TrendingUp } from "lucide-react"
import { api } from "../api"
import { useApp, wsName } from "./App"

/**
 * Global palette (Ctrl+K): navigate, switch workspace, jump to sessions.
 * Pure client-side commands — the runtime's slash commands run inside a
 * session, not here.
 */

interface Item {
  key: string
  icon: React.ReactNode
  label: string
  hint?: string
  run: () => void
}

export function CommandPalette({ onClose }: { onClose: () => void }): React.ReactElement {
  const navigate = useNavigate()
  const { sessions, workspace, setWorkspace } = useApp()
  const workspacesOf = useMemo(() => [...new Set(sessions.map((s) => s.workspace).filter(Boolean))], [sessions])
  const [q, setQ] = useState("")
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo<Item[]>(() => {
    const base: Item[] = [
      { key: "home", icon: <ArrowRight size={13} />, label: "回到封面", hint: "Home", run: () => navigate("/") },
      {
        key: "new",
        icon: <Plus size={13} />,
        label: "打开当前工作区的常驻会话",
        hint: workspace ? wsName(workspace) : undefined,
        run: () => api.createSession(undefined, workspace || undefined).then((r) => navigate(`/s/${r.sessionId}`)).catch(() => {}),
      },
      { key: "usage", icon: <TrendingUp size={13} />, label: "用量", run: () => navigate("/usage") },
      { key: "memory", icon: <Database size={13} />, label: "记忆", run: () => navigate("/memory") },
      { key: "schedules", icon: <Timer size={13} />, label: "定时任务", run: () => navigate("/schedules") },
      { key: "settings", icon: <Cog size={13} />, label: "设置", run: () => navigate("/settings") },
    ]
    const wsItems: Item[] = workspacesOf.map((ws) => ({
      key: `ws-${ws}`,
      icon: <FolderClosed size={13} />,
      label: `工作区:${wsName(ws)}`,
      hint: ws,
      run: () => setWorkspace(ws),
    }))
    const sessionItems: Item[] = sessions
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12)
      .map((s) => ({
        key: `s-${s.sessionId}`,
        icon: <MessageSquare size={13} />,
        label: s.title ?? "未命名会话",
        hint: s.workspace ? wsName(s.workspace) : undefined,
        run: () => navigate(`/s/${s.sessionId}`),
      }))
    return [...base, ...wsItems, ...sessionItems]
  }, [sessions, workspacesOf, workspace, setWorkspace, navigate])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return items
    return items.filter((it) => (it.label + " " + (it.hint ?? "")).toLowerCase().includes(needle))
  }, [items, q])

  useEffect(() => setSel(0), [q])

  const commit = (it: Item | undefined): void => {
    if (!it) return
    it.run()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[16vh]" onClick={onClose}>
      <div className="menu pop-in w-[540px] overflow-hidden !p-0" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-sm outline-none placeholder:text-ghost"
          placeholder="搜索会话、工作区、页面…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setSel((v) => Math.min(v + 1, filtered.length - 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setSel((v) => Math.max(v - 1, 0))
            } else if (e.key === "Enter") {
              e.preventDefault()
              commit(filtered[sel])
            }
          }}
        />
        <div className="max-h-[320px] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-sm text-ghost">没有匹配项</div>}
          {filtered.map((it, i) => (
            <button
              key={it.key}
              className={"menu-item " + (i === sel ? "bg-sel text-fg" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={() => commit(it)}
            >
              <span className="flex-none text-faint">{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="max-w-[180px] flex-none truncate font-mono text-2xs text-ghost">{it.hint}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2 font-mono text-2xs text-ghost">
          <span className="kbd">↑↓</span> 选择 <span className="kbd">Enter</span> 确认 <span className="kbd">Esc</span> 关闭
        </div>
      </div>
    </div>
  )
}
