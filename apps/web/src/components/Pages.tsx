import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  ArrowRight,
  Cpu,
  Database,
  ListChecks,
  RefreshCw,
  Send,
  Timer,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react"
import { api, relativeTime, type Schedule } from "../api"
import { useApp, wsName } from "./App"

/**
 * Tool pages: usage analytics, memory browser, schedules. Shared page
 * chrome: fixed-width column, mono section labels, dense tables.
 */

function PageHead({ title, sub }: { title: string; sub: string }): React.ReactElement {
  return (
    <div className="mb-6">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-faint">{sub}</p>
    </div>
  )
}

function Page({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-6 py-10">{children}</div>
    </div>
  )
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }): React.ReactElement {
  return (
    <div className="card px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-faint">
        {icon}
        <span className="font-mono text-2xs uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-1.5 font-mono text-[17px] font-medium leading-none">{value}</div>
      {sub && <div className="mt-1 text-2xs text-ghost">{sub}</div>}
    </div>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
  return String(n)
}

/* ================= Usage ================= */

export function UsagePage(): React.ReactElement {
  const navigate = useNavigate()
  const { refreshSessions } = useApp()
  const [days, setDays] = useState(30)
  const [usage, setUsage] = useState<import("../api").UsageSummary | null>(null)

  useEffect(() => {
    api.usage(days).then(setUsage).catch(() => {})
  }, [days])

  const heat = useMemo(() => {
    if (!usage) return []
    const byDay = new Map(usage.days.map((d) => [d.day, d]))
    const out: Array<{ day: string; v: number; input: number; output: number }> = []
    const now = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      const row = byDay.get(key)
      out.push({ day: key, v: row ? row.inputTokens + row.outputTokens : 0, input: row?.inputTokens ?? 0, output: row?.outputTokens ?? 0 })
    }
    return out
  }, [usage, days])

  const max = Math.max(...heat.map((h) => h.v), 1)

  if (!usage) {
    return (
      <Page>
        <PageHead title="用量" sub="token 与成本随时间的分布" />
        <p className="text-sm text-faint">加载中…</p>
      </Page>
    )
  }

  return (
    <Page>
      <PageHead title="用量" sub="token 与成本随时间的分布(来源:事件日志里的 usage 聚合)" />
      <div className="mb-4 flex items-center gap-1.5">
        {[7, 14, 30].map((d) => (
          <button key={d} className={"btn " + (d === days ? "btn-primary" : "")} onClick={() => setDays(d)}>
            {d} 天
          </button>
        ))}
        <button className="btn btn-quiet ml-1" title="刷新" onClick={() => api.usage(days).then(setUsage).catch(() => {})}>
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2.5">
        <StatCard icon={<ArrowUpIconMini />} label="输入" value={fmtTokens(usage.totals.inputTokens)} />
        <StatCard icon={<Send size={12} />} label="输出" value={fmtTokens(usage.totals.outputTokens)} />
        <StatCard icon={<Zap size={12} />} label="步数" value={String(usage.totals.steps)} />
        <StatCard icon={<Cpu size={12} />} label="成本" value={"$" + usage.totals.cost.toFixed(2)} sub={`活跃会话 ${usage.sessions}`} />
      </div>

      {/* heatmap */}
      <div className="card mt-4 px-4 py-4">
        <div className="label mb-3">每日 token 热力</div>
        <div className="grid grid-flow-col grid-rows-7 gap-[3px]" style={{ gridAutoColumns: "14px" }}>
          {heat.map((h) => (
            <div
              key={h.day}
              className="heat-cell"
              title={`${h.day}: ${fmtTokens(h.v)} tokens`}
              style={{
                background: h.v === 0 ? "var(--hover)" : `color-mix(in srgb, var(--accent) ${Math.max(14, Math.round((h.v / max) * 100))}%, var(--bg2))`,
              }}
            />
          ))}
        </div>
      </div>

      {/* per-session ranking */}
      {usage.sessionRows.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="border-b border-line px-4 py-2.5 font-mono text-2xs uppercase tracking-wide text-faint">会话排行</div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="font-mono text-2xs text-ghost">
                <th className="px-4 py-2 text-left font-normal">会话</th>
                <th className="px-3 py-2 text-right font-normal">输入</th>
                <th className="px-3 py-2 text-right font-normal">输出</th>
                <th className="px-3 py-2 text-right font-normal">步数</th>
                <th className="px-4 py-2 text-right font-normal">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {usage.sessionRows.map((r) => (
                <tr
                  key={r.sessionId}
                  className="cursor-pointer border-t border-line transition-colors hover:bg-hover"
                  onClick={() => navigate(`/s/${r.sessionId}`)}
                >
                  <td className="max-w-[280px] truncate px-4 py-2 font-mono text-2xs">
                    {r.sessionId}
                    {r.model && <span className="chip ml-2 !py-0 !text-2xs">{r.model}</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-2xs">{fmtTokens(r.inputTokens)}</td>
                  <td className="px-3 py-2 text-right font-mono text-2xs">{fmtTokens(r.outputTokens)}</td>
                  <td className="px-3 py-2 text-right font-mono text-2xs">{r.steps}</td>
                  <td className="px-4 py-2 text-right font-mono text-2xs text-faint">{relativeTime(r.lastActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  )
}

function ArrowUpIconMini(): React.ReactElement {
  return <ArrowRight size={12} className="rotate-[-45deg]" />
}

/* ================= Memory ================= */

export function MemoryPage(): React.ReactElement {
  const [q, setQ] = useState("")
  const [items, setItems] = useState<Array<import("../api").MemoryRecord>>([])
  const { workspace } = useApp()

  const load = (): void => {
    api.memory(q).then((r) => setItems(r.memories)).catch(() => {})
  }
  useEffect(load, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Page>
      <PageHead title="记忆" sub={`语义记忆条目(来源:${workspace ? wsName(workspace) : "全局"} 会话的沉淀)`} />
      <input className="input mb-4" placeholder="搜索记忆…" value={q} onChange={(e) => setQ(e.target.value)} />
      {items.length === 0 && <p className="text-sm text-faint">还没有记忆。会话里说“记住…”或启用自动提取后,条目会出现在这里。</p>}
      <div className="space-y-2">
        {items.map((m) => (
          <div key={m.id} className="card group flex items-start gap-3 px-4 py-3">
            <Database size={13} className="mt-1 flex-none text-faint" />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] leading-relaxed">{m.content}</div>
              <div className="mt-1.5 flex items-center gap-2 font-mono text-2xs text-ghost">
                <span className="chip !py-0 !text-2xs">{m.type}</span>
                <span>p{m.priority}</span>
                <span>{relativeTime(m.createdAt)}</span>
              </div>
            </div>
            <button
              className="icon-btn !h-6 !w-6 opacity-0 transition-opacity group-hover:opacity-100"
              title="删除"
              onClick={() => api.deleteMemory(m.id).then(load).catch(() => {})}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </Page>
  )
}

/* ================= Schedules ================= */

export function SchedulesPage(): React.ReactElement {
  const { sessions } = useApp()
  const navigate = useNavigate()
  const [items, setItems] = useState<Schedule[]>([])
  const [armDelete, setArmDelete] = useState<string | null>(null)

  const load = (): void => {
    api.schedules().then((r) => setItems(r.schedules)).catch(() => {})
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const titleOf = (sessionId: string): string => {
    const s = sessions.find((x) => x.sessionId === sessionId)
    return s ? `"${(s.title ?? "未命名").slice(0, 18)}"` : "会话 " + sessionId.slice(0, 8)
  }

  const rhythm = (s: Schedule): string => (s.cron ? `cron ${s.cron}` : s.dailyAt ? `每天 ${s.dailyAt}` : `每 ${s.intervalMinutes ?? "?"} 分钟`)

  return (
    <Page>
      <PageHead title="定时任务" sub="按节奏把固定提示注入目标会话(由 runtime 持久调度)" />
      {items.length === 0 && <p className="text-sm text-faint">还没有定时任务。</p>}
      <div className="space-y-2">
        {items.map((s) => (
          <div key={s.id} className="card flex items-center gap-3 px-4 py-3">
            <button
              className={"toggle " + (s.enabled ? "on" : "")}
              title={s.enabled ? "停用" : "启用"}
              onClick={() => api.updateSchedule(s.id, { enabled: !s.enabled }).then(load).catch(() => {})}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">{s.prompt}</div>
              <div className="mt-1 flex items-center gap-2 font-mono text-2xs text-ghost">
                <Timer size={11} />
                {rhythm(s)}
                <span className="text-ghost">→</span>
                <button className="hover:text-fg" onClick={() => navigate(`/s/${s.sessionId}`)}>
                  {titleOf(s.sessionId)}
                </button>
                {s.lastRunAt && <span>· 上次 {relativeTime(s.lastRunAt)}</span>}
                {s.lastResult === "error" && (
                  <span className="inline-flex items-center gap-1" style={{ color: "var(--bad)" }}>
                    <TriangleAlert size={10} />
                    失败
                  </span>
                )}
              </div>
            </div>
            <button className="btn" title="立即执行" onClick={() => api.runSchedule(s.id).then(load).catch(() => {})}>
              <Send size={11} />
            </button>
            <button
              className={"btn btn-danger " + (armDelete === s.id ? "!border-bad" : "")}
              title={armDelete === s.id ? "再点一次确认删除" : "删除"}
              onClick={() => {
                if (armDelete !== s.id) return setArmDelete(s.id)
                api.removeSchedule(s.id).then(load).catch(() => {})
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 text-2xs text-ghost">
        <ListChecks size={11} />
        新任务在设置 → 会话能力里添加,或让 newhorse 自己登记。
      </div>
    </Page>
  )
}
