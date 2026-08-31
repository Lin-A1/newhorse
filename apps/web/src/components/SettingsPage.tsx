import { useEffect, useState } from "react"
import { Cpu, Info, Palette, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react"
import { api } from "../api"
import { useStore } from "../store"
import { cycleTheme, getThemePref, type ThemePref } from "../theme"
import { Globe as IconGlobe, Sun as IconSun, Moon as IconMoon, Monitor as IconMonitor } from "lucide-react"
import { IconCheck } from "./icons"

type SectionId = "model" | "budget" | "memory" | "network" | "appearance" | "about"

const SECTIONS: Array<{ id: SectionId; label: string; Icon: LucideIcon }> = [
  { id: "model", label: "模型与供应商", Icon: Cpu },
  { id: "budget", label: "上下文预算", Icon: SlidersHorizontal },
  { id: "memory", label: "记忆与权限", Icon: ShieldCheck },
  { id: "network", label: "局域网访问", Icon: IconGlobe },
  { id: "appearance", label: "外观", Icon: Palette },
  { id: "about", label: "关于", Icon: Info },
]

/** Settings — a full page (not a modal): a left section nav that can grow,
 *  solid panels, inline save feedback. Writes go to the agent-home config. */
export function SettingsPage() {
  const { settings, reloadSettings, showToast } = useStore()
  const [section, setSection] = useState<SectionId>("model")
  const [keyInput, setKeyInput] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState("")

  useEffect(() => {
    setKeyInput("")
    setErr("")
  }, [section])

  if (!settings) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-10 text-[13px] text-faint">加载设置…</div>
      </div>
    )
  }

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

  const saveKey = async (): Promise<void> => {
    if (!keyInput.trim()) return
    await patch({ provider: { kind: settings.provider.kind, baseUrl: settings.provider.baseUrl, apiKey: keyInput } })
    setKeyInput("")
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 md:flex-row md:px-8">
        {/* left nav */}
        <nav className="flex shrink-0 flex-row gap-1 overflow-x-auto md:sticky md:top-8 md:w-44 md:flex-col md:self-start">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${section === s.id ? "bg-surface2 font-medium text-fg shadow-[inset_0_1px_0_rgba(127,127,127,0.08)]" : "text-dim hover:bg-surface hover:text-fg"}`}
            >
              <s.Icon size={15} strokeWidth={1.8} className={section === s.id ? "text-accent" : "opacity-70"} />
              {s.label}
            </button>
          ))}
        </nav>

        {/* content */}
        <div className="min-w-0 flex-1">
          {err && <div className="mb-3 rounded-xl border border-bad/25 bg-bad/[0.08] px-3.5 py-2.5 text-xs text-bad">{err}</div>}

          {section === "model" && (
            <Panel title="模型与供应商" desc="协议 / 地址 / 密钥；修改对新会话生效。">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="协议">
                  <select className="input-base" value={settings.provider.kind} onChange={(e) => patch({ provider: { kind: e.target.value, baseUrl: settings.provider.baseUrl } })}>
                    {["openai", "openai-compatible", "anthropic", "openai-responses"].map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Base URL">
                  <input className="input-base" defaultValue={settings.provider.baseUrl} onBlur={(e) => e.target.value !== settings.provider.baseUrl && patch({ provider: { kind: settings.provider.kind, baseUrl: e.target.value } })} />
                </Field>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={<>API Key{settings.provider.hasApiKey && <span className="ml-1 text-faint">（已设置 {settings.provider.apiKeyHint}）</span>}</>}>
                  <div className="relative">
                    <input className="input-base pr-12" type={showKey ? "text" : "password"} placeholder={settings.provider.hasApiKey ? "留空保持不变" : "粘贴 API Key"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} autoComplete="off" />
                    <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 text-[10px] text-faint transition-colors hover:text-fg" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? "隐藏" : "显示"}
                    </button>
                  </div>
                </Field>
                <Field label="模型（在会话输入框的胶囊里切换）">
                  <div className="flex items-center gap-2">
                    <div className="input-base flex items-center !py-0 text-[13px]" style={{ minHeight: 34 }}>
                      {settings.model}
                    </div>
                    {keyInput.trim() && (
                      <button className="btn-primary shrink-0 !px-3 !py-1.5 !text-xs" disabled={saving} onClick={() => void saveKey()}>
                        保存 Key
                      </button>
                    )}
                  </div>
                </Field>
              </div>
              {!settings.provider.hasApiKey && !keyInput.trim() && (
                <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn">
                  <Info size={13} />
                  尚未设置 API Key——先在上方粘贴一个再保存，模型下拉列表才能拉取。
                </div>
              )}
            </Panel>
          )}

          {section === "budget" && (
            <Panel title="上下文预算" desc="压缩触发与折叠尾部随窗口自动缩放；不填则用保守默认值。">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="上下文窗口（tokens）">
                  <input type="number" className="input-base" defaultValue={settings.contextWindowTokens ?? ""} placeholder="如 128000" onBlur={(e) => patch({ contextWindowTokens: Number(e.target.value) || undefined })} />
                </Field>
                <Field label="单次输出上限（tokens）">
                  <input type="number" className="input-base" defaultValue={settings.maxOutputTokens ?? ""} placeholder="如 16384" onBlur={(e) => patch({ maxOutputTokens: Number(e.target.value) || undefined })} />
                </Field>
              </div>
            </Panel>
          )}

          {section === "memory" && (
            <Panel title="记忆与权限" desc="记忆在会话中自动沉淀；权限决定工具是否需要审批。">
              <div className="grid gap-2.5 md:grid-cols-2">
                <Toggle label="记忆" on={settings.memory.on} onToggle={(v) => patch({ memory: { ...settings.memory, on: v } })} />
                <Toggle label="自动沉淀（提取管线）" on={settings.memory.extraction} onToggle={(v) => patch({ memory: { ...settings.memory, on: v || settings.memory.on, extraction: v } })} />
                <Toggle label="语义检索（向量）" on={settings.memory.vector.enabled} onToggle={(v) => patch({ memory: { ...settings.memory, on: settings.memory.on, vector: { ...settings.memory.vector, enabled: v } } })} />
                <Field label="权限级别">
                  <select className="input-base" value={settings.approvalPolicy} onChange={(e) => patch({ approvalPolicy: e.target.value })}>
                    <option value="strict">strict（默认审批）</option>
                    <option value="readonly">readonly（计划模式）</option>
                    <option value="trusted">trusted（完全访问）</option>
                  </select>
                </Field>
              </div>
            </Panel>
          )}

          {section === "network" && (
            <Panel title="局域网访问" desc="手机 / 其他设备通过同一地址访问；开放局域网必须设置令牌。">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="绑定地址（0.0.0.0 = 开放局域网）">
                  <input className="input-base" defaultValue={settings.host} onBlur={(e) => e.target.value !== settings.host && patch({ host: e.target.value })} />
                </Field>
                <Field label={<>访问令牌{settings.hasToken && <span className="ml-1 text-ok">已设置</span>}</>}>
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
                </Field>
              </div>
              <p className="text-[11px] text-faint">修改绑定地址后需重启服务（桌面端重启一次应用）。</p>
            </Panel>
          )}

          {section === "appearance" && <AppearanceSection />}

          {section === "about" && (
            <Panel title="关于" desc="引擎主目录与版本信息。">
              <Row k="引擎主目录" v={settings.agentHome} mono />
              <Row k="工作区" v={settings.workspace} mono />
              <Row k="运行端口" v={String(settings.port)} mono />
              <Row k="Bash 工具" v={settings.allowBash ? "已启用" : "未启用"} />
              <Row k="插件代码" v={settings.allowPluginCode ? "已启用" : "未启用"} />
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

function Panel({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="pop-in space-y-4 rounded-2xl border border-linestrong bg-surface2 p-5 shadow-raise">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
        {desc && <p className="mt-0.5 text-[12px] text-faint">{desc}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5 text-xs text-dim">
      {label}
      {children}
    </label>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px]">
      <span className="text-faint">{k}</span>
      <span className={`truncate text-fg ${mono ? "font-mono text-[11.5px]" : ""}`}>{v}</span>
    </div>
  )
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:bg-surface2">
      <span className="text-[13px] text-fg">{label}</span>
      <button className={`nh-toggle ${on ? "on" : ""}`} onClick={() => onToggle(!on)} aria-label={label} aria-pressed={on}>
        <span className="knob" />
      </button>
    </div>
  )
}

function AppearanceSection() {
  const [pref, setPref] = useState<ThemePref>(getThemePref())
  const options: Array<{ id: ThemePref; label: string; Icon: LucideIcon }> = [
    { id: "system", label: "跟随系统", Icon: IconMonitor },
    { id: "light", label: "浅色", Icon: IconSun },
    { id: "dark", label: "深色", Icon: IconMoon },
  ]
  const pick = (id: ThemePref): void => {
    // cycleTheme persists + applies; cycle until the wanted pref is active
    let guard = 0
    let cur = getThemePref()
    while (cur !== id && guard < 3) {
      cur = cycleTheme()
      guard++
    }
    setPref(getThemePref())
  }
  return (
    <Panel title="外观" desc="界面明暗；默认跟随操作系统。">
      <div className="grid grid-cols-3 gap-2.5">
        {options.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => pick(id)}
            className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-all ${pref === id ? "border-accent/60 bg-accent/[0.08] text-fg shadow-glow" : "border-line bg-surface text-dim hover:border-linestrong hover:text-fg"}`}
          >
            <Icon size={18} className={pref === id ? "text-accent" : ""} />
            <span className="text-[12px] font-medium">{label}</span>
            {pref === id && <IconCheck size={13} className="text-accent" />}
          </button>
        ))}
      </div>
    </Panel>
  )
}
