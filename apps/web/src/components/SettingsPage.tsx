import { useEffect, useState } from "react"
import { api } from "../api"

interface EffectiveSettings {
  model: string
  provider: { kind: string; baseUrl: string; hasApiKey: boolean; apiKeyHint?: string }
  contextWindowTokens?: number
  maxOutputTokens?: number
  host: string
  port: number
  workspace: string
  approvalPolicy: string
  memory: { on: boolean; extraction: boolean; vector: { enabled: boolean; mode: string } }
  allowBash: boolean
  allowPluginCode: boolean
  hasToken: boolean
  agentHome: string
}

/** Settings page: provider quick-config with model pulling (模型名称拉取),
 *  compaction budgets, memory toggles, permission level, LAN access. */
export function SettingsPage() {
  const [s, setS] = useState<EffectiveSettings | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [msg, setMsg] = useState("")
  const [err, setErr] = useState("")
  const [keyInput, setKeyInput] = useState("")
  const [saving, setSaving] = useState(false)

  const load = (): Promise<void> =>
    api
      .settings()
      .then((r) => setS(r as unknown as EffectiveSettings))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    void load()
  }, [])

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    setSaving(true)
    setErr("")
    try {
      await api.putSettings(p)
      await load()
      setMsg("已保存（新会话生效）")
      setTimeout(() => setMsg(""), 2500)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const pullModels = async (): Promise<void> => {
    setErr("")
    try {
      const r = await api.models()
      setModels(r.models)
      if (r.models.length === 0) setErr("供应商未返回模型列表（检查 BaseURL / Key）")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (!s) return <div className="p-6 text-sm text-slate-500">{err || "加载中…"}</div>

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-2xl mx-auto pb-24">
      <h1 className="text-lg font-semibold">设置</h1>
      {msg && <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs px-3 py-2">{msg}</div>}
      {err && <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs px-3 py-2">{err}</div>}

      {/* Provider / model */}
      <section className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">模型与供应商</div>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-xs text-slate-500 space-y-1 block">
            协议
            <select className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" value={s.provider.kind} onChange={(e) => patch({ provider: { ...s.provider, kind: e.target.value } })}>
              {["openai", "openai-compatible", "anthropic", "openai-responses"].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500 space-y-1 block">
            Base URL
            <input className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" defaultValue={s.provider.baseUrl} onBlur={(e) => e.target.value !== s.provider.baseUrl && patch({ provider: { ...s.provider, kind: s.provider.kind, baseUrl: e.target.value } })} />
          </label>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-xs text-slate-500 space-y-1 block">
            API Key {s.provider.hasApiKey && <span className="text-slate-400">（已设置 {s.provider.apiKeyHint}）</span>}
            <input className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" placeholder={s.provider.hasApiKey ? "留空保持不变" : "粘贴 API Key"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
          </label>
          <label className="text-xs text-slate-500 space-y-1 block">
            模型
            <div className="flex gap-2">
              {models.length > 0 ? (
                <select className="flex-1 rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" value={s.model} onChange={(e) => patch({ model: e.target.value })}>
                  {!models.includes(s.model) && <option value={s.model}>{s.model}</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="flex-1 rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" defaultValue={s.model} onBlur={(e) => e.target.value !== s.model && patch({ model: e.target.value })} />
              )}
              <button className="rounded-lg border border-ink-600 px-3 text-sm hover:bg-ink-700 shrink-0" onClick={pullModels} title="从供应商拉取可用模型">
                拉取
              </button>
            </div>
          </label>
        </div>
        {keyInput && (
          <button className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-ink-950" disabled={saving} onClick={() => patch({ provider: { ...s.provider, kind: s.provider.kind, baseUrl: s.provider.baseUrl, apiKey: keyInput } }).then(() => setKeyInput(""))}>
            保存 Key
          </button>
        )}
      </section>

      {/* Compaction budgets */}
      <section className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">上下文预算</div>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-xs text-slate-500 space-y-1 block">
            上下文窗口（tokens）
            <input type="number" className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" defaultValue={s.contextWindowTokens ?? ""} placeholder="如 128000" onBlur={(e) => patch({ contextWindowTokens: Number(e.target.value) || undefined })} />
          </label>
          <label className="text-xs text-slate-500 space-y-1 block">
            单次输出上限（tokens）
            <input type="number" className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" defaultValue={s.maxOutputTokens ?? ""} placeholder="如 16384" onBlur={(e) => patch({ maxOutputTokens: Number(e.target.value) || undefined })} />
          </label>
        </div>
        <div className="text-[11px] text-slate-600">压缩触发与折叠尾部随窗口自动缩放；不填则用保守默认值。</div>
      </section>

      {/* Memory + permission */}
      <section className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">记忆与权限</div>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          <Toggle label="记忆" on={s.memory.on} onToggle={(v) => patch({ memory: { ...s.memory, on: v } })} />
          <Toggle label="自动沉淀（提取管线）" on={s.memory.extraction} onToggle={(v) => patch({ memory: { ...s.memory, on: v || s.memory.on, extraction: v } })} />
          <Toggle label="语义检索（向量）" on={s.memory.vector.enabled} onToggle={(v) => patch({ memory: { ...s.memory, on: s.memory.on, vector: { ...s.memory.vector, enabled: v } } })} />
          <label className="text-xs text-slate-500 space-y-1 block">
            权限级别
            <select className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" value={s.approvalPolicy} onChange={(e) => patch({ approvalPolicy: e.target.value })}>
              <option value="strict">strict（默认审批）</option>
              <option value="readonly">readonly（计划模式）</option>
              <option value="trusted">trusted（完全访问）</option>
            </select>
          </label>
        </div>
      </section>

      {/* LAN access */}
      <section className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">局域网访问（手机 / 其他设备）</div>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-xs text-slate-500 space-y-1 block">
            绑定地址（0.0.0.0 = 开放局域网）
            <input className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" defaultValue={s.host} onBlur={(e) => e.target.value !== s.host && patch({ host: e.target.value })} />
          </label>
          <label className="text-xs text-slate-500 space-y-1 block">
            访问令牌 {s.hasToken && <span className="text-emerald-400">已设置</span>}
            <input className="w-full rounded-lg bg-ink-900 border border-ink-600 px-2 py-1.5 text-sm text-slate-200" placeholder="设置后本页存入 localStorage" onKeyDown={(e) => {
              if (e.key === "Enter") {
                localStorage.setItem("NEWHORSE_TOKEN", (e.target as HTMLInputElement).value)
                setMsg("令牌已存入本机浏览器")
                setTimeout(() => setMsg(""), 2500)
              }
            }} />
          </label>
        </div>
        <div className="text-[11px] text-slate-600">开放局域网必须设置令牌；修改绑定地址后需重启服务（桌面端：开关一次局域网访问）。</div>
      </section>

      <div className="text-[11px] text-slate-600">引擎主目录：{s.agentHome}</div>
    </div>
  )
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-ink-900 border border-ink-700 px-3 py-2">
      <span className="text-slate-300 text-sm">{label}</span>
      <button
        className={`w-10 h-5 rounded-full relative transition-colors ${on ? "bg-accent" : "bg-ink-600"}`}
        onClick={() => onToggle(!on)}
        aria-label={label}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </div>
  )
}
