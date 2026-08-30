import { useEffect, useMemo, useState } from "react"
import { api, type Schedule } from "../api"

/** Usage heatmap (用量统计): per-day token totals folded from durable
 *  StepEnded events — GitHub-style intensity grid + totals + per-model. */
export function UsagePage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Awaited<ReturnType<typeof api.usage>> | null>(null)
  const [err, setErr] = useState("")

  useEffect(() => {
    api
      .usage(days)
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [days])

  const grid = useMemo(() => {
    if (!data) return []
    const map = new Map(data.days.map((d) => [d.day, d]))
    const out: Array<{ day: string; output: number; input: number; steps: number } | null> = []
    const start = new Date()
    start.setDate(start.getDate() - (days - 1))
    for (let i = 0; i < days; i++) {
      const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`
      const hit = map.get(key)
      out.push(hit ? { day: key, output: hit.outputTokens, input: hit.inputTokens, steps: hit.steps } : null)
      start.setDate(start.getDate() + 1)
    }
    return out
  }, [data, days])

  const max = Math.max(1, ...grid.map((g) => g?.output ?? 0))
  const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  const models = useMemo(() => {
    const acc = new Map<string, number>()
    for (const d of data?.days ?? []) for (const [m, v] of Object.entries(d.byModel)) acc.set(m, (acc.get(m) ?? 0) + v.outputTokens)
    return [...acc.entries()].sort((a, b) => b[1] - a[1])
  }, [data])

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">用量统计</h1>
        <select className="rounded-lg bg-ink-800 border border-ink-600 text-sm px-2 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
        </select>
      </div>
      {err && <div className="text-xs text-red-300">{err}</div>}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "输入 tokens", value: data?.totals.inputTokens ?? 0 },
          { label: "输出 tokens", value: data?.totals.outputTokens ?? 0 },
          { label: "步数 / 会话", value: `${data?.totals.steps ?? 0} / ${data?.sessions ?? 0}` },
        ].map((c) => (
          <div key={c.label} className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4">
            <div className="text-xs text-slate-500">{c.label}</div>
            <div className="text-xl font-semibold mt-1">{fmt(c.value as number)}</div>
          </div>
        ))}
      </div>

      {/* Heatmap */}
      <div className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4">
        <div className="text-xs text-slate-500 mb-3">每日输出强度</div>
        <div className="grid grid-flow-col grid-rows-7 gap-[3px] overflow-x-auto pb-1" style={{ gridAutoColumns: "14px" }}>
          {grid.map((g, i) => (
            <div
              key={i}
              title={g ? `${g.day} · out ${fmt(g.output)} · in ${fmt(g.input)} · ${g.steps} 步` : "无记录"}
              className="w-[14px] h-[14px] rounded-[3px]"
              style={{ backgroundColor: g ? `rgba(109,139,255,${0.12 + 0.88 * (g.output / max)})` : "rgba(255,255,255,0.04)" }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5 mt-3 text-[11px] text-slate-600">
          少
          {[0.12, 0.35, 0.6, 0.85, 1].map((o) => (
            <div key={o} className="w-[12px] h-[12px] rounded-[3px]" style={{ backgroundColor: `rgba(109,139,255,${o})` }} />
          ))}
          多
        </div>
      </div>

      {/* Per-model */}
      <div className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4">
        <div className="text-xs text-slate-500 mb-2">按模型</div>
        {models.length === 0 && <div className="text-sm text-slate-600">暂无数据（旧会话产生于时间戳功能之前）</div>}
        <div className="space-y-2">
          {models.map(([m, v]) => (
            <div key={m} className="flex items-center gap-3 text-sm">
              <div className="w-44 truncate text-slate-300">{m}</div>
              <div className="flex-1 h-2 rounded bg-ink-700 overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${(v / (models[0]?.[1] || 1)) * 100}%` }} />
              </div>
              <div className="text-xs text-slate-500 w-16 text-right">{fmt(v)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Scheduled prompts (定时任务) page. */
export function SchedulesPage() {
  const [rows, setRows] = useState<Schedule[]>([])
  const [sessions, setSessions] = useState<Array<{ sessionId: string; title?: string }>>([])
  const [form, setForm] = useState({ sessionId: "", prompt: "", mode: "daily" as "interval" | "daily" | "cron", intervalMinutes: 60, dailyAt: "09:00", cron: "0 9 * * *" })
  const [err, setErr] = useState("")

  const refresh = (): Promise<void> => api.schedules().then((r) => setRows(r.schedules)).catch(() => {})
  useEffect(() => {
    void refresh()
    api.sessions().then(setSessions).catch(() => {})
  }, [])

  const create = async (): Promise<void> => {
    setErr("")
    const base = { sessionId: form.sessionId, prompt: form.prompt }
    const input = form.mode === "interval" ? { ...base, intervalMinutes: form.intervalMinutes } : form.mode === "daily" ? { ...base, dailyAt: form.dailyAt } : { ...base, cron: form.cron }
    try {
      await api.addSchedule(input)
      setForm({ ...form, prompt: "" })
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold">定时任务</h1>

      <div className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4 space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-xs text-slate-500 space-y-1 block">
            目标会话
            <select className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value })}>
              <option value="">选择会话…</option>
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.title || s.sessionId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500 space-y-1 block">
            节奏
            <select className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as typeof form.mode })}>
              <option value="daily">每天固定时间</option>
              <option value="interval">每隔 N 分钟</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </label>
        </div>
        {form.mode === "interval" && (
          <label className="text-xs text-slate-500 block">
            间隔（分钟）
            <input type="number" min={1} className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })} />
          </label>
        )}
        {form.mode === "daily" && (
          <label className="text-xs text-slate-500 block">
            时间
            <input type="time" className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" value={form.dailyAt} onChange={(e) => setForm({ ...form, dailyAt: e.target.value })} />
          </label>
        )}
        {form.mode === "cron" && (
          <label className="text-xs text-slate-500 block">
            Cron（分 时 日 月 周）
            <input className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200 font-mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
          </label>
        )}
        <label className="text-xs text-slate-500 block">
          提示词（到点作为用户消息发给会话）
          <textarea className="w-full resize-none rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" rows={2} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
        </label>
        {err && <div className="text-xs text-red-300">{err}</div>}
        <button className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-ink-950 disabled:opacity-40" disabled={!form.sessionId || !form.prompt.trim()} onClick={create}>
          创建定时任务
        </button>
      </div>

      <div className="space-y-2">
        {rows.length === 0 && <div className="text-sm text-slate-600">还没有定时任务</div>}
        {rows.map((s) => (
          <div key={s.id} className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-200 whitespace-pre-wrap">{s.prompt}</div>
              <div className="text-[11px] text-slate-500 mt-1">
                {s.intervalMinutes ? `每 ${s.intervalMinutes} 分钟` : s.dailyAt ? `每天 ${s.dailyAt}` : `cron: ${s.cron}`} · 会话 {s.sessionId.slice(0, 8)}
                {s.lastRunAt ? ` · 上次 ${new Date(s.lastRunAt).toLocaleString()} ${s.lastResult === "ok" ? "✅" : "❌"}` : " · 未运行过"}
                {s.lastError ? ` · ${s.lastError}` : ""}
              </div>
            </div>
            <button className="text-xs rounded-lg border border-ink-600 px-2 py-1 hover:bg-ink-700" onClick={() => api.runSchedule(s.id).then(refresh)}>
              运行
            </button>
            <button className="text-xs rounded-lg border border-ink-600 px-2 py-1 hover:bg-ink-700" onClick={() => api.updateSchedule(s.id, { enabled: !s.enabled }).then(refresh)}>
              {s.enabled ? "暂停" : "启用"}
            </button>
            <button className="text-xs rounded-lg border border-red-500/40 text-red-300 px-2 py-1 hover:bg-red-500/10" onClick={() => api.removeSchedule(s.id).then(refresh)}>
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
