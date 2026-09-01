import { useMemo, useState } from "react"
import type { StoredEventRow } from "../api"
import { IconChevron } from "./icons"

export interface ContextStats {
  messages: number
  userMessages: number
  assistantMessages: number
  toolMessages: number
  model?: string
  windowTokens?: number
  estTokens: number
  ratio?: number
  tokensUsed: number
  goalBudget?: number
  goalUsed?: number
}

/** Per-role character proportions from the durable log — an honest estimate
 *  (the runtime counts tokens per step, not per role), good for the shape of
 *  the context, not an invoice. */
function roleBreakdown(events: StoredEventRow[]): Array<{ role: string; chars: number }> {
  const acc: Record<string, number> = { system: 0, user: 0, assistant: 0, tool: 0 }
  for (const e of events) {
    if (e.type === "Session.Prompted") acc.user! += String(e.data.prompt ?? "").length
    else if (e.type === "Session.MessageAppended") {
      const m = (e.data.message ?? {}) as { kind?: string; text?: string; content?: Array<{ text?: string }>; output?: unknown }
      const len = m.kind === "assistant" ? (m.content ?? []).reduce((n, p) => n + (p.text?.length ?? 0), 0) : m.kind === "tool" ? JSON.stringify(m.output ?? "").length : (m.text?.length ?? 0)
      acc[m.kind && m.kind in acc ? m.kind : "tool"]! += len
    } else if (e.type === "Session.Compacted") {
      acc.system! += String((e.data as { summary?: string }).summary ?? "").length
    }
  }
  const total = Object.values(acc).reduce((a, b) => a + b, 0)
  if (total === 0) return []
  return (["assistant", "user", "tool", "system"] as const).map((role) => ({ role, chars: acc[role]! })).filter((r) => r.chars > 0)
}

const ROLE_COLOR: Record<string, string> = { assistant: "var(--accent)", user: "var(--ok)", tool: "var(--warn)", system: "var(--txt-faint)" }

/** Session Context panel (opencode's Context tab): a stats grid, an estimated
 *  role breakdown of the context, and the effective system prompt. */
export function ContextPanel({ events, stats, systemPrompt, onClose }: { events: StoredEventRow[]; stats: ContextStats; systemPrompt: string | undefined; onClose: () => void }) {
  const [promptOpen, setPromptOpen] = useState(false)
  const breakdown = useMemo(() => roleBreakdown(events), [events])
  const totalChars = breakdown.reduce((n, r) => n + r.chars, 0)
  const created = events[0]?.ts

  const grid: Array<[string, string]> = [
    ["模型", stats.model ?? "—"],
    ["消息", `${stats.messages}（用户 ${stats.userMessages} / 助手 ${stats.assistantMessages} / 工具 ${stats.toolMessages}）`],
    ["上下文窗口", stats.windowTokens ? `${stats.windowTokens.toLocaleString()} tok` : "未设置（保守回退）"],
    ["预估上下文", `${stats.estTokens.toLocaleString()} tok${stats.ratio !== undefined ? ` · ${Math.round(stats.ratio * 100)}%` : ""}`],
    ["累计消耗", `${stats.tokensUsed.toLocaleString()} tok`],
    ...(stats.goalBudget ? ([["目标预算", `${stats.goalUsed ?? 0} / ${stats.goalBudget.toLocaleString()} tok`]] as Array<[string, string]>) : []),
    ["创建时间", created ? new Date(created).toLocaleString() : "—"],
  ]

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-chrome/60" data-nh-popover>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 text-[11.5px] font-medium text-dim">会话上下文</span>
        <button className="nh-icon-btn" onClick={onClose} aria-label="关闭上下文面板">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* context meter */}
        {stats.windowTokens !== undefined && (
          <div className="mb-3">
            <div className="mb-1 flex items-baseline justify-between text-[10.5px] text-faint">
              <span>窗口占用</span>
              <span className="tnum">{Math.round((stats.ratio ?? 0) * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div className={`h-full rounded-full ${(stats.ratio ?? 0) > 0.8 ? "bg-bad" : "bg-accent"}`} style={{ width: `${Math.min(100, Math.round((stats.ratio ?? 0) * 100))}%` }} />
            </div>
          </div>
        )}
        {/* stats grid */}
        <div className="space-y-1">
          {grid.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px]">
              <span className="shrink-0 text-faint">{k}</span>
              <span className="min-w-0 truncate text-right text-fg" title={v}>{v}</span>
            </div>
          ))}
        </div>
        {/* role breakdown (estimated) */}
        {breakdown.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[10.5px] text-faint">构成（按字符估算）</div>
            <div className="flex h-2 overflow-hidden rounded-full bg-line">
              {breakdown.map((r) => (
                <div key={r.role} title={`${r.role} · ${Math.round((r.chars / totalChars) * 100)}%`} style={{ width: `${(r.chars / totalChars) * 100}%`, background: ROLE_COLOR[r.role] }} />
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-faint">
              {breakdown.map((r) => (
                <span key={r.role} className="inline-flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: ROLE_COLOR[r.role] }} />
                  {r.role} {Math.round((r.chars / totalChars) * 100)}%
                </span>
              ))}
            </div>
          </div>
        )}
        {/* system prompt viewer (opencode Context tab) */}
        {systemPrompt && (
          <div className="mt-3">
            <button className="flex w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px] text-dim transition-colors hover:border-linestrong hover:text-fg" onClick={() => setPromptOpen(!promptOpen)}>
              <IconChevron size={11} className={`transition-transform ${promptOpen ? "rotate-90" : ""}`} />
              系统提示词（工作区上下文）
              <span className="ml-auto text-[10px] text-faint">{systemPrompt.length.toLocaleString()} 字符</span>
            </button>
            {promptOpen && <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-[var(--code-bg)] p-2.5 font-mono text-[10.5px] leading-relaxed text-faint">{systemPrompt}</pre>}
          </div>
        )}
      </div>
    </div>
  )
}
