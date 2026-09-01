import { useEffect, useMemo, useState } from "react"
import { api, prettyTitle, relativeTime, type MemoryRecord, type UsageSummary } from "../api"
import { useStore } from "../store"
import { IconChart, IconClock, IconFile, IconMemory } from "./icons"

function PageHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="rise mb-5">
      <h1 className="text-[19px] font-semibold tracking-tight text-fg">{title}</h1>
      {sub && <p className="mt-1 text-[12.5px] text-faint">{sub}</p>}
    </div>
  )
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Usage: per-day intensity grid + totals + per-model bars. */
export function UsagePage() {
  const { showToast, setView, sessions } = useStore()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<UsageSummary | null>(null)
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
    <div className="h-full overflow-y-auto"><div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 xl:max-w-[1000px] 2xl:max-w-[1160px]">
      <PageHeader title="用量统计" sub="来自持久事件日志的真实计步数据" />
      <div className="mb-4 flex justify-end">
        <select className="input-base !w-auto text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
        </select>
      </div>
      {err && <div className="mb-3 rounded-xl border border-bad/25 bg-bad/[0.07] px-3.5 py-2.5 text-xs text-bad">{err}</div>}

      {data && !err && data.sessions === 0 && (
        <div className="rise panel flex flex-col items-center gap-2.5 px-6 py-14 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface2">
            <IconChart size={17} className="text-faint" />
          </div>
          <div className="text-[14px] font-medium text-fg">还没有用量记录</div>
          <p className="max-w-sm text-[12.5px] leading-relaxed text-faint">完成一次对话后，这里会显示真实统计：输入 / 输出 tokens、执行步数、每日强度与各模型消耗。</p>
          <button
            className="btn-primary mt-1 !px-4 !py-1.5 !text-[13px]"
            onClick={() => window.dispatchEvent(new CustomEvent("nh-open-settings"))}
          >
            先去配置一个供应商
          </button>
        </div>
      )}

      {(!data || data.sessions > 0) && (
      <>
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: "输入 tokens", value: fmt(data?.totals.inputTokens ?? 0) },
          { label: "输出 tokens", value: fmt(data?.totals.outputTokens ?? 0) },
          { label: "缓存读 / 写", value: `${fmt(data?.totals.cacheReadTokens ?? 0)} / ${fmt(data?.totals.cacheWriteTokens ?? 0)}` },
          { label: "推理 tokens", value: fmt(data?.totals.reasoningTokens ?? 0) },
          { label: "成本", value: (data?.totals.cost ?? 0) > 0 ? `$${(data!.totals.cost).toFixed(2)}` : "—" },
          { label: "步数", value: fmt(data?.totals.steps ?? 0) },
          { label: "活跃会话", value: fmt(data?.sessions ?? 0) },
        ].map((c, i) => (
          <div key={c.label} className="panel rise p-4 hover:!border-linestrong" style={{ ["--d" as string]: `${i * 50}ms` }}>
            <div className="text-[11px] text-faint">{c.label}</div>
            <div className="tnum mt-1 text-[20px] font-semibold tracking-tight text-fg">{c.value}</div>
          </div>
        ))}
      </div>

      <div className="panel mb-4 rise p-4" style={{ ["--d" as string]: "210ms" }}>
        <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">每日输出强度</div>
        <div className="grid grid-flow-col grid-rows-7 gap-[3px] overflow-x-auto pb-1" style={{ gridAutoColumns: "15px" }}>
          {grid.map((g, i) => (
            <div
              key={i}
              title={g ? `${g.day} · out ${fmt(g.output)} · in ${fmt(g.input)} · ${g.steps} 步` : "无记录"}
              className="h-[15px] w-[15px] rounded-[4px] transition-transform duration-100 hover:scale-125"
              style={{ backgroundColor: g ? `rgb(var(--accent-rgb) / ${0.12 + 0.88 * (g.output / max)})` : "var(--cell-empty)" }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[10.5px] text-faint">
          少
          {[0.12, 0.34, 0.56, 0.78, 1].map((o) => (
            <div key={o} className="h-[12px] w-[12px] rounded-[3px]" style={{ backgroundColor: `rgb(var(--accent-rgb) / ${o})` }} />
          ))}
          多
        </div>
      </div>

      {data && data.sessionRows.length > 0 && (
        <div className="panel rise mb-4 p-4" style={{ ["--d" as string]: "250ms" }}>
          <div className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">会话排行 · 按输出 tokens</div>
          <div className="space-y-1">
            {data.sessionRows.slice(0, 8).map((r) => (
              <button
                key={r.sessionId}
                className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-linestrong hover:bg-surface2"
                onClick={() => {
                  localStorage.setItem("NEWHORSE_CURRENT_SESSION", r.sessionId)
                  setView({ kind: "session", id: r.sessionId })
                }}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{prettyTitle(sessions.find((x) => x.sessionId === r.sessionId)?.title, r.sessionId.slice(0, 8))}</span>
                {r.model && <span className="shrink-0 text-[10.5px] text-faint">{r.model.split("/").pop()}</span>}
                <span className="tnum shrink-0 text-[11px] text-faint">in {fmt(r.inputTokens)}</span>
                <span className="tnum shrink-0 text-[11px] text-accent">out {fmt(r.outputTokens)}</span>
                <span className="tnum shrink-0 text-[10.5px] text-faint">{relativeTime(r.lastActivity)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="panel rise p-4" style={{ ["--d" as string]: "280ms" }}>
        <div className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">按模型</div>
        {models.length === 0 && <div className="text-[13px] text-faint">暂无数据（历史会话产生于时间戳之前）</div>}
        <div className="space-y-2.5">
          {models.map(([m, v], i) => (
            <div key={m} className="flex items-center gap-3 text-[13px]">
              <div className="w-44 truncate text-dim">{m}</div>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface2">
                <div className="grow-x h-full rounded-full bg-gradient-to-r from-accent to-accent-2" style={{ width: `${(v / (models[0]?.[1] || 1)) * 100}%`, ["--d" as string]: `${350 + i * 80}ms` }} />
              </div>
              <div className="tnum w-14 text-right text-[11px] text-faint">{fmt(v)}</div>
            </div>
          ))}
        </div>
      </div>
      </>
      )}
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

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
    <div className="h-full overflow-y-auto"><div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 xl:max-w-[1000px] 2xl:max-w-[1160px]">
      <PageHeader title="定时任务" sub="到点把提示词作为用户消息发进目标会话" />

      <div className="panel rise mb-5 space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1 text-xs text-faint">
            目标会话
            <select className="input-base" value={form.sessionId} onChange={(e) => setForm({ ...form, sessionId: e.target.value })}>
              <option value="">选择会话…</option>
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {prettyTitle(s.title, s.sessionId.slice(0, 8))}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs text-faint">
            节奏
            <select className="input-base" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as typeof form.mode })}>
              <option value="daily">每天固定时间</option>
              <option value="interval">每隔 N 分钟</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </label>
        </div>
        {form.mode === "interval" && (
          <label className="block space-y-1 text-xs text-faint">
            间隔（分钟）
            <input type="number" min={1} className="input-base" value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })} />
          </label>
        )}
        {form.mode === "daily" && (
          <label className="block space-y-1 text-xs text-faint">
            时间
            <input type="time" className="input-base" value={form.dailyAt} onChange={(e) => setForm({ ...form, dailyAt: e.target.value })} />
          </label>
        )}
        {form.mode === "cron" && (
          <label className="block space-y-1 text-xs text-faint">
            Cron（分 时 日 月 周）
            <input className="input-base font-mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
          </label>
        )}
        <label className="block space-y-1 text-xs text-faint">
          提示词
          <textarea className="input-base resize-none" rows={2} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
        </label>
        {err && <div className="text-xs text-bad">{err}</div>}
        <button className="btn-primary px-4 py-1.5 text-[13px]" disabled={!form.sessionId || !form.prompt.trim()} onClick={create}>
          创建定时任务
        </button>
      </div>

      <div className="space-y-2.5">
        {rows.length === 0 && (
          <div className="rise panel flex flex-col items-center gap-2.5 px-6 py-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface2">
              <IconClock size={17} className="text-faint" />
            </div>
            <div className="text-[14px] font-medium text-fg">还没有定时任务</div>
            <p className="max-w-sm text-[12.5px] leading-relaxed text-faint">在上方创建一条：到点把提示词作为用户消息发进目标会话（比如每天早上汇报仓库状态）。</p>
          </div>
        )}
        {rows.map((s, i) => {
          const target = sessions.find((x) => x.sessionId === s.sessionId)
          const confirmKey = `sched-${s.id}`
          const confirming = confirmKey === confirmDelete
          return (
            <div key={s.id} className="panel rise flex items-start gap-3 p-4 hover:!border-linestrong" style={{ ["--d" as string]: `${i * 60}ms` }}>
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface2">
                <IconClock size={13} className={s.enabled ? "text-accent" : "text-faint"} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{s.prompt}</div>
                <div className="tnum mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                  <span className={`pill !py-0 !text-[10px] ${s.enabled ? "!border-ok/25 !bg-ok/10 !text-ok" : "!text-faint"}`}>{s.enabled ? "启用中" : "已暂停"}</span>
                  <span className="rounded border border-line bg-surface2 px-1.5 py-px">{s.intervalMinutes ? `每 ${s.intervalMinutes} 分钟` : s.dailyAt ? `每天 ${s.dailyAt}` : `cron: ${s.cron}`}</span>
                  <span className="text-faint">→</span>
                  <span className="truncate">{target ? prettyTitle(target.title, target.sessionId.slice(0, 8)) : s.sessionId.slice(0, 8)}</span>
                  {s.lastRunAt && <span className={s.lastResult === "ok" ? "text-ok/80" : "text-bad/80"}>{` · 上次 ${new Date(s.lastRunAt).toLocaleString()} ${s.lastResult === "ok" ? "成功" : "失败"}`}</span>}
                  {s.lastError ? <span className="text-bad/80">{` · ${s.lastError}`}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <button className="btn-ghost !rounded-lg !px-2.5 !py-1 !text-[11px]" onClick={() => api.runSchedule(s.id).then(refresh).then(() => showToast("已手动触发"))}>
                  运行
                </button>
                <button className="btn-ghost !rounded-lg !px-2.5 !py-1 !text-[11px]" onClick={() => api.updateSchedule(s.id, { enabled: !s.enabled }).then(refresh)}>
                  {s.enabled ? "暂停" : "启用"}
                </button>
                <button
                  className={confirming ? "btn-danger !rounded-lg !px-2.5 !py-1 !text-[11px]" : "btn-ghost !rounded-lg !px-2.5 !py-1 !text-[11px] hover:!text-bad"}
                  onClick={() => {
                    if (!confirming) {
                      setConfirmDelete(confirmKey)
                      setTimeout(() => setConfirmDelete((c) => (c === confirmKey ? null : c)), 2500)
                      return
                    }
                    setConfirmDelete(null)
                    api.removeSchedule(s.id).then(refresh).then(() => showToast("已删除"))
                  }}
                >
                  {confirming ? "确认删除" : "删除"}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}

/** Memory browser. */
export function MemoryPage() {
  const { showToast } = useStore()
  const [rows, setRows] = useState<MemoryRecord[]>([])
  const [q, setQ] = useState("")
  const [err, setErr] = useState("")

  const refresh = (query = ""): Promise<void> =>
    api
      .memory(query)
      .then((r) => setRows(r.memories))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))

  const [newText, setNewText] = useState("")
  const addMemory = async (): Promise<void> => {
    if (!newText.trim()) return
    try {
      await fetch("/v1/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: newText.trim(), type: "fact", priority: 60 }) })
      setNewText("")
      showToast("记忆已写入")
      await refresh(q)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const disabled = /no memory store configured/i.test(err)

  return (
    <div className="h-full overflow-y-auto"><div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 xl:max-w-[1000px] 2xl:max-w-[1160px]">
      <PageHeader title="记忆库" sub={`语义 + 关键词混合检索的持久记忆${rows.length > 0 ? ` · ${rows.length} 条` : ""}`} />
      {disabled ? (
        <div className="rise panel flex flex-col items-center gap-2.5 px-6 py-14 text-center">
          <div className="text-[14px] font-medium text-dim">记忆功能未开启</div>
          <p className="max-w-sm text-[12.5px] leading-relaxed text-faint">开启后，会话中重要的结论会被自动沉淀，并在后续任务里通过语义检索被找回。</p>
          <button className="btn-primary mt-1 !px-4 !py-1.5 !text-[13px]" onClick={() => window.dispatchEvent(new CustomEvent("nh-open-settings"))}>
            去设置里开启记忆
          </button>
        </div>
      ) : (
        <>
          <div className="mb-4 flex gap-2">
            <input
              className="input-base flex-1"
              placeholder="搜索记忆…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && refresh(q)}
            />
            <button className="btn-primary !px-5 text-[13px]" onClick={() => refresh(q)}>
              搜索
            </button>
          </div>
          <div className="flex gap-2">
            <input className="input-base flex-1" placeholder="手动写入一条记忆…" value={newText} onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addMemory()} />
            <button className="btn-ghost px-3 text-[13px]" onClick={addMemory}>
              写入
            </button>
          </div>
          {err && <div className="mb-3 rounded-xl border border-bad/25 bg-bad/[0.07] px-3.5 py-2.5 text-xs text-bad">{err}</div>}
          <div className="space-y-2.5">
            {rows.length === 0 && (
              <div className="rise panel flex flex-col items-center gap-2.5 px-6 py-12 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface2">
                  <IconMemory size={17} className="text-faint" />
                </div>
                <div className="text-[14px] font-medium text-fg">{q ? "没有命中" : "记忆库还是空的"}</div>
                <p className="max-w-sm text-[12.5px] leading-relaxed text-faint">
                  {q ? "换个关键词试试，或用空白搜索看全部记忆。" : "会话进行时，模型会把重要的结论通过 memory_write 自动沉淀到这里；也可以手动搜索已沉淀的内容。"}
                </p>
                {!q && (
                  <button className="btn-primary mt-1 !px-4 !py-1.5 !text-[13px]" onClick={() => window.dispatchEvent(new CustomEvent("nh-open-settings"))}>
                    检查记忆设置
                  </button>
                )}
              </div>
            )}
        {rows.map((m, i) => (
          <div key={m.id} className="rise group overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:bg-surface2" style={{ ["--d" as string]: `${i * 50}ms` }}>
            <div className="flex items-start gap-3 p-4">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-panel-strong">
                <IconFile size={13} className="text-faint" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="rounded border border-line bg-surface2 px-1.5 py-px text-[9.5px] text-faint">{m.type}</span>
                  {m.priority >= 80 && <span className="rounded border border-bad/25 bg-bad/[0.08] px-1.5 py-px text-[9.5px] text-bad">高优先</span>}
                  {m.sessionId && <span className="tnum rounded border border-line bg-surface2 px-1.5 py-px text-[9.5px] text-faint">来自 {m.sessionId.slice(0, 8)}</span>}
                  {m.createdAt > 0 && <span className="tnum text-[9.5px] text-faint">{relativeTime(m.createdAt)}</span>}
                </div>
                <div className="text-[13px] leading-relaxed text-fg">{m.content}</div>
              </div>
              <button
                className="btn-danger shrink-0 !rounded-lg !px-2.5 !py-1 !text-[11px] opacity-60 transition-opacity hover:opacity-100"
                aria-label="删除"
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
            {/* beautifului Context Cards footer: badge · chars · source */}
            <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2 text-[11px] text-faint">
              <span className="inline-flex h-[20px] items-center rounded-full bg-accent-soft px-2 text-[10.5px] font-medium text-accent">{m.type}</span>
              <span className="tnum">{m.content.length} 字符</span>
              <span className="text-line-strong">·</span>
              <span>优先级 {m.priority}</span>
              <span className="text-line-strong">·</span>
              <span className="tnum">{new Date(m.createdAt).toLocaleString()}</span>
            </div>
          </div>
        ))}
          </div>
        </>
      )}
      </div>
    </div>
  )
}
