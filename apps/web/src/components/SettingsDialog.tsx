import { useEffect, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import { IconX } from "./icons"

/** Settings dialog (modal, cc-switch style): provider quick-config, budgets,
 *  memory/permission, LAN access. Persists into the agent-home config file. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, reloadSettings, showToast } = useStore()
  const [keyInput, setKeyInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState("")

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  if (!settings) return null

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    setSaving(true)
    setErr("")
    try {
      await api.putSettings(p)
      await reloadSettings()
      showToast("已保存（新会话生效）")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const pullModels = async (): Promise<string[]> => {
    try {
      const r = await api.models()
      if (r.models.length === 0) setErr("供应商未返回模型列表（检查 BaseURL / Key）")
      return r.models
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return []
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="nh-rise max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/[0.09] bg-[#0e111a] p-5 shadow-[0_30px_80px_rgba(0,0,0,0.6)]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-100">设置</h2>
          <button className="btn-ghost !p-1.5" onClick={onClose} aria-label="关闭">
            <IconX size={15} />
          </button>
        </div>

        {err && <div className="mb-3 rounded-xl bg-red-500/[0.08] border border-red-500/25 text-red-300 text-xs px-3.5 py-2.5">{err}</div>}

        {/* provider */}
        <section className="mb-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">模型与供应商</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1 text-xs text-slate-500">
              协议
              <select className="input-base" value={settings.provider.kind} onChange={(e) => patch({ provider: { kind: e.target.value, baseUrl: settings.provider.baseUrl } })}>
                {["openai", "openai-compatible", "anthropic", "openai-responses"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-xs text-slate-500">
              Base URL
              <input className="input-base" defaultValue={settings.provider.baseUrl} onBlur={(e) => e.target.value !== settings.provider.baseUrl && patch({ provider: { kind: settings.provider.kind, baseUrl: e.target.value } })} />
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1 text-xs text-slate-500">
              API Key {settings.provider.hasApiKey && <span className="text-slate-400">（已设置 {settings.provider.apiKeyHint}）</span>}
              <input className="input-base" placeholder={settings.provider.hasApiKey ? "留空保持不变" : "粘贴 API Key"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
            </label>
            <div className="space-y-1 text-xs text-slate-500">
              模型
              <div className="text-[13px] text-slate-200">{settings.model}</div>
              {keyInput && (
                <button className="btn-primary mt-1 w-full py-1.5 text-xs" disabled={saving} onClick={() => patch({ provider: { kind: settings.provider.kind, baseUrl: settings.provider.baseUrl, apiKey: keyInput } }).then(() => setKeyInput(""))}>
                  保存 Key
                </button>
              )}
            </div>
          </div>
        </section>

        {/* budgets */}
        <section className="mb-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">上下文预算</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1 text-xs text-slate-500">
              上下文窗口（tokens）
              <input type="number" className="input-base" defaultValue={settings.contextWindowTokens ?? ""} placeholder="如 128000" onBlur={(e) => patch({ contextWindowTokens: Number(e.target.value) || undefined })} />
            </label>
            <label className="block space-y-1 text-xs text-slate-500">
              单次输出上限（tokens）
              <input type="number" className="input-base" defaultValue={settings.maxOutputTokens ?? ""} placeholder="如 16384" onBlur={(e) => patch({ maxOutputTokens: Number(e.target.value) || undefined })} />
            </label>
          </div>
          <div className="text-[11px] text-slate-600">压缩触发与折叠尾部随窗口自动缩放；不填则用保守默认值。</div>
        </section>

        {/* memory + permission */}
        <section className="mb-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">记忆与权限</div>
          <div className="grid gap-3 md:grid-cols-2 text-sm">
            <Toggle label="记忆" on={settings.memory.on} onToggle={(v) => patch({ memory: { ...settings.memory, on: v } })} />
            <Toggle label="自动沉淀（提取管线）" on={settings.memory.extraction} onToggle={(v) => patch({ memory: { ...settings.memory, on: v || settings.memory.on, extraction: v } })} />
            <Toggle label="语义检索（向量）" on={settings.memory.vector.enabled} onToggle={(v) => patch({ memory: { ...settings.memory, on: settings.memory.on, vector: { ...settings.memory.vector, enabled: v } } })} />
            <label className="block space-y-1 text-xs text-slate-500">
              权限级别
              <select className="input-base" value={settings.approvalPolicy} onChange={(e) => patch({ approvalPolicy: e.target.value })}>
                <option value="strict">strict（默认审批）</option>
                <option value="readonly">readonly（计划模式）</option>
                <option value="trusted">trusted（完全访问）</option>
              </select>
            </label>
          </div>
        </section>

        {/* LAN */}
        <section className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500">局域网访问（手机 / 其他设备）</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1 text-xs text-slate-500">
              绑定地址（0.0.0.0 = 开放局域网）
              <input className="input-base" defaultValue={settings.host} onBlur={(e) => e.target.value !== settings.host && patch({ host: e.target.value })} />
            </label>
            <label className="block space-y-1 text-xs text-slate-500">
              访问令牌 {settings.hasToken && <span className="text-emerald-400">已设置</span>}
              <input
                className="input-base"
                placeholder="设置后存入本机浏览器"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    localStorage.setItem("NEWHORSE_TOKEN", (e.target as HTMLInputElement).value)
                    showToast("令牌已存入本机浏览器")
                  }
                }}
              />
            </label>
          </div>
          <div className="text-[11px] text-slate-600">开放局域网必须设置令牌；修改绑定地址后需重启服务（桌面端：重启一次应用或服务）。</div>
        </section>

        <div className="mt-4 text-[11px] text-slate-600">引擎主目录：{settings.agentHome}</div>
      </div>
    </div>
  )
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
      <span className="text-[13px] text-slate-300">{label}</span>
      <button className={`relative h-5 w-10 rounded-full transition-colors ${on ? "bg-accent" : "bg-white/[0.1]"}`} onClick={() => onToggle(!on)} aria-label={label}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </div>
  )
}
