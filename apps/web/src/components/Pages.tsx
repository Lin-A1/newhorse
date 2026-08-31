import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"

function PageHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-[17px] font-semibold tracking-tight text-slate-100">{title}</h1>
      {sub && <p className="mt-0.5 text-[12.5px] text-slate-500">{sub}</p>}
    </div>
  )
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Usage: per-day intensity grid + totals + per-model bars. */
export function UsagePage() {
  const { showToast } = useStore()
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
  const models = useMemo(() => {
    const acc = new Map<string, number>()
    for (const d of data?.days ?? []) for (const [m, v] of Object.entries(d.byModel)) acc.set(m, (acc.get(m) ?? 0) + v.outputTokens)
    return [...acc.entries()].sort((a, b) => b[1] - a[1])
  }, [data])

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
      <PageHeader title="用量统计" sub="来自持久事件日志的真实计步数据" />
      <div className="mb-4 flex justify-end">
        <select className="input-base !w-auto text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
        </select>
      </div>
      {err && <div className="mb-3 text-xs text-red-300">{err}</div>}

      <div className="mb-4 grid grid-cols-3 gap-2.5">
        {[
          { label: "输入 tokens", value: fmt(data?.totals.inputTokens ?? 0) },
          { label: "输出 tokens", value: fmt(data?.totals.outputTokens ?? 0) },
          { label: "步数 / 会话", value: `${data?.totals.steps ?? 0} / ${data?.sessions ?? 0}` },
        ].map((c) => (
          <div key={c.label} className="panel p-4">
            <div className="text-[11px] text-slate-500">{c.label}</div>
            <div className="mt-1 text-[22px] font-semibold tracking-tight text-slate-100">{c.value}</div>
          </div>
        ))}
      </div>

      <div className="panel mb-4 p-4">
        <div className="mb-3 text-[11px] uppercase tracking-wider text-slate-600">每日输出强度</div>
        <div className="grid grid-flow-col grid-rows-7 gap-[3px] overflow-x-auto pb-1" style={{ gridAutoColumns: "15px" }}>
          {grid.map((g, i) => (
            <div
              key={i}
              title={g ? `${g.day} · out ${fmt(g.output)} · in ${fmt(g.input)} · ${g.steps} 步` : "无记录"}
              className="h-[15px] w-[15px] rounded-[4px]"
              style={{ backgroundColor: g ? `rgba(125,155,255,${0.1 + 0.9 * (g.output / max)})` : "rgba(255,255,255,0.035)" }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[10.5px] text-slate-600">
          少
          {[0.1, 0.32, 0.55, 0.8, 1].map((o) => (
            <div key={o} className="h-[12px] w-[12px] rounded-[3px]" style={{ backgroundColor: `rgba(125,155,255,${o})` }} />
          ))}
          多
        </div>
      </div>

      <div className="panel p-4">
        <div className="mb-2.5 text-[11px] uppercase tracking-wider text-slate-600">按模型</div>
        {models.length === 0 && <div className="text-[13px] text-slate-600">暂无数据（历史会话产生于时间戳之前）</div>}
        <div className="space-y-2.5">
          {models.map(([m, v]) => (
            <div key={m} className="flex items-center gap-3 text-[13px]">
              <div className="w-44 truncate text-slate-300">{m}</div>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2" style={{ width: `${(v / (models[0]?.[1] || 1)) * 100}%` }} />
              </div>
              <div className="w-14 text-right text-[11px] text-slate-500">{fmt(v)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Scheduled prompts (定时任务). */
export function SchedulesPage() {
  const { showToast } = useStore()
  const [rows, setRows] = useState<Array<{ id: string; sessionId: string; prompt: string; enabled: boolean; intervalMinutes?: number; dailyAt?: string; cron?: string; lastRunAt?: number; lastResult?: string; lastError?: string }>>([])
  const [sessions, setSessions] = useState<Array<{ sessionId: string; title?: string }>>([])
  const [form, setForm] = useState({ sessionId: "", prompt: "", mode: "daily" as "interval" | "daily" | "cron", intervalMinutes: 60, dailyAt: "09:00", cron: "0 9 * * *" })
  const [err, setErr] = useState("")

  const refresh = (): Promise<void> =>
    api
      .schedules()
      .then((r) => setRows(r.schedules))
      .catch(() => {})
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
      showToast("定时任务已创建")
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
      <PageHeader title="定时任务" sub="到点把提示词作为用户消息发进目标会话" />

      <div className="panel mb-5 space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1 text-xs text-slate-500">
            目标会话
            <select className="input-base" value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value })}>
              <option value="">选择会话…</option>
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.title || s.sessionId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs text-slate-500">
            节奏
            <select className="input-base" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as typeof form.mode })}>
              <option value="daily">每天固定时间</option>
              <option value="interval">每隔 N 分钟</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </label>
        </div>
        {form.mode === "interval" && (
          <label className="block space-y-1 text-xs text-slate-500">
            间隔（分钟）
            <input type="number" min={1} className="input-base" value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })} />
          </label>
        )}
        {form.mode === "daily" && (
          <label className="block space-y-1 text-xs text-slate-500">
            时间
            <input type="time" className="input-base" value={form.dailyAt} onChange={(e) => setForm({ ...form, dailyAt: e.target.value })} />
          </label>
        )}
        {form.mode === "cron" && (
          <label className="block space-y-1 text-xs text-slate-500">
            Cron（分 时 日 月 周）
            <input className="input-base font-mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
          </label>
        )}
        <label className="block space-y-1 text-xs text-slate-500">
          提示词
          <textarea className="input-base resize-none" rows={2} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
        </label>
        {err && <div className="text-xs text-red-300">{err}</div>}
        <button className="btn-primary px-4 py-1.5 text-[13px]" disabled={!form.sessionId || !form.prompt.trim()} onClick={create}>
          创建定时任务
        </button>
      </div>

      <div className="space-y-2.5">
        {rows.length === 0 && <div className="text-[13px] text-slate-600">还没有定时任务</div>}
        {rows.map((s) => (
          <div key={s.id} className="panel flex items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="whitespace-pre-wrap text-[13px] text-slate-200">{s.prompt}</div>
              <div className="mt-1 text-[11px] text-slate-500">
                {s.intervalMinutes ? `每 ${s.intervalMinutes} 分钟` : s.dailyAt ? `每天 ${s.dailyAt}` : `cron: ${s.cron}`} · 会话 {s.sessionId.slice(0, 8)}
                {s.lastRunAt ? ` · 上次 ${new Date(s.lastRunAt).toLocaleString()} ${s.lastResult === "ok" ? "成功" : "失败"}` : " · 未运行过"}
                {s.lastError ? ` · ${s.lastError}` : ""}
              </div>
            </div>
            <button className="btn-ghost !rounded-lg px-2 py-1 text-[11px]" onClick={() => api.runSchedule(s.id).then(refresh)}>
              运行
            </button>
            <button className="btn-ghost !rounded-lg px-2 py-1 text-[11px]" onClick={() => api.updateSchedule(s.id, { enabled: !s.enabled }).then(refresh)}>
              {s.enabled ? "暂停" : "启用"}
            </button>
            <button className="rounded-lg border border-red-500/25 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10" onClick={() => api.removeSchedule(s.id).then(refresh)}>
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Memory browser. */
export function MemoryPage() {
  const { showToast } = useStore()
  const [rows, setRows] = useState<Array<{ id: string; content: string; type: string; priority: number; createdAt: number }>>([])
  const [q, setQ] = useState("")
  const [err, setErr] = useState("")

  const refresh = (query = ""): Promise<void> =>
    api
      .memory(query)
      .then((r) => setRows(r.memories))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
      <PageHeader title="记忆库" sub="语义 + 关键词混合检索的持久记忆" />
      <div className="mb-4 flex gap-2">
        <input
          className="input-base flex-1"
          placeholder="搜索记忆…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && refresh(q)}
        />
        <button className="btn-primary px-4 text-[13px]" onClick={() => refresh(q)}>
          搜索
        </button>
      </div>
      {err && <div className="mb-3 text-xs text-red-300">{err}</div>}
      <div className="space-y-2.5">
        {rows.length === 0 && <div className="text-[13px] text-slate-600">没有记忆{q ? "命中" : "（会话中模型会自动沉淀）"}</div>}
        {rows.map((m) => (
          <div key={m.id} className="panel flex items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-slate-200">{m.content}</div>
              <div className="mt-1 text-[11px] text-slate-500">
                {m.type} · 优先级 {m.priority} · {new Date(m.createdAt).toLocaleString()}
              </div>
            </div>
            <button
              className="rounded-lg border border-red-500/25 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
              onClick={() =>
                api
                  .deleteMemory(m.id)
                  .then(() => {
                    showToast("已删除")
                    return refresh(q)
                  })
                  .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
              }
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
