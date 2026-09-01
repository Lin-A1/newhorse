import { useEffect, useState } from "react"
import { CheckCircle2, Database, KeyRound, Moon, Plug, Shield, Sparkles, Terminal } from "lucide-react"
import { api } from "../api"
import type { EffectiveSettingsView, ProviderProfileView } from "../types"

/**
 * Settings: same data surface as before, rebuilt in the new system. Sections:
 * 模型(活跃供应商 + 预设切换 + 预算) · 记忆 · 会话能力(策略/命令执行) ·
 * 网络(token) · 外观(主题/通知) · 关于。
 */

type Section = "model" | "memory" | "capability" | "network" | "appearance" | "about"

const SECTIONS: Array<{ key: Section; label: string; icon: React.ReactNode }> = [
  { key: "model", label: "模型与供应商", icon: <Sparkles size={13} /> },
  { key: "memory", label: "记忆", icon: <Database size={13} /> },
  { key: "capability", label: "会话能力", icon: <Shield size={13} /> },
  { key: "network", label: "网络与访问", icon: <Plug size={13} /> },
  { key: "appearance", label: "外观", icon: <Moon size={13} /> },
  { key: "about", label: "关于", icon: <Terminal size={13} /> },
]

export function SettingsPage(): React.ReactElement {
  const [s, setS] = useState<EffectiveSettingsView | null>(null)
  const [section, setSection] = useState<Section>("model")
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState("")

  const load = (): void => {
    api.settings().then(setS).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<Record<string, unknown>>): Promise<unknown> => {
    setError("")
    return api
      .putSettings(p)
      .then((next) => {
        setS(next)
        setSaved(true)
        setTimeout(() => setSaved(false), 1600)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  if (!s) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-6 py-10 text-sm text-faint">{error || "加载设置…"}</div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] gap-8 px-6 py-10">
        {/* nav */}
        <nav className="w-[150px] flex-none">
          <div className="sticky top-0 space-y-0.5">
            {SECTIONS.map((sec) => (
              <button key={sec.key} className={"nav-item " + (section === sec.key ? "on" : "")} onClick={() => setSection(sec.key)}>
                {sec.icon}
                {sec.label}
              </button>
            ))}
          </div>
        </nav>

        {/* body */}
        <div className="min-w-0 flex-1 pb-16">
          <div className="mb-5 flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">{SECTIONS.find((x) => x.key === section)?.label}</h1>
            {saved && (
              <span className="flex items-center gap-1 font-mono text-2xs text-ok">
                <CheckCircle2 size={11} />
                已保存
              </span>
            )}
            {error && <span className="font-mono text-2xs text-bad">{error}</span>}
          </div>

          {section === "model" && <ModelSection s={s} patch={patch} reload={load} />}
          {section === "memory" && <MemorySection s={s} patch={patch} />}
          {section === "capability" && <CapabilitySection s={s} patch={patch} />}
          {section === "network" && <NetworkSection s={s} patch={patch} />}
          {section === "appearance" && <AppearanceSection />}
          {section === "about" && <AboutSection s={s} />}
        </div>
      </div>
    </div>
  )
}

/* ---------- building blocks ---------- */

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[13px] font-medium">{label}</div>
      {children}
      {hint && <div className="mt-1 text-2xs leading-relaxed text-ghost">{hint}</div>}
    </div>
  )
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }): React.ReactElement {
  return (
    <div className="mb-3 flex items-center gap-3">
      <button className={"toggle " + (on ? "on" : "")} onClick={() => onChange(!on)} />
      <div>
        <div className="text-[13px]">{label}</div>
        {hint && <div className="text-2xs text-ghost">{hint}</div>}
      </div>
    </div>
  )
}

/* ---------- sections ---------- */

function ModelSection({ s, patch, reload }: { s: EffectiveSettingsView; patch: (p: Partial<Record<string, unknown>>) => Promise<unknown>; reload: () => void }): React.ReactElement {
  const [budget, setBudget] = useState(String(s.maxOutputTokens ?? ""))
  const providers = s.providers ?? []

  const activate = (p: ProviderProfileView): void => {
    patch({ activeProviderId: p.id }).then(reload)
  }

  return (
    <>
      <div className="card mb-5 px-4 py-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="label">当前供应商</span>
          <span className="chip chip-accent">{s.provider.kind}</span>
        </div>
        <div className="font-mono text-2xs text-dim">{s.provider.baseUrl}</div>
        <div className="mt-2 flex items-center gap-2 text-2xs">
          <KeyRound size={11} className="text-faint" />
          <span className={s.provider.hasApiKey ? "text-ok" : "text-bad"}>{s.provider.hasApiKey ? `已配置 ${s.provider.apiKeyHint ?? ""}` : "未配置密钥"}</span>
          <span className="text-ghost">· 模型</span>
          <span className="chip !py-0.5">{s.model}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="默认模型">
            <input className="input font-mono text-2xs" defaultValue={s.model} onBlur={(e) => e.target.value !== s.model && patch({ model: e.target.value })} />
          </Field>
          <Field label="上下文窗口 (tokens)">
            <input
              className="input font-mono text-2xs"
              defaultValue={s.contextWindowTokens ?? ""}
              onBlur={(e) => patch({ contextWindowTokens: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
        </div>
        <Field label="单次回复输出预算 (maxOutputTokens)" hint="anthropic 协议在缺失时会静默截断到 4096 tokens;留空则不限制">
          <input className="input font-mono text-2xs" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={(e) => patch({ maxOutputTokens: e.target.value ? Number(e.target.value) : null })} />
        </Field>
      </div>

      {/* provider presets (ccswitch semantics): one row per preset, click to activate */}
      <div className="mb-2 flex items-center gap-3">
        <span className="label">供应商预设</span>
        <span className="h-px flex-1 bg-line" />
        <span className="text-2xs text-ghost">点击切换 · 原子生效</span>
      </div>
      <div className="space-y-2">
        {providers.map((p) => {
          const isActivePreset = p.id === s.activeProviderId
          return (
            <div key={p.id} className={"card px-4 py-3 transition-colors " + (isActivePreset ? "!border-accent" : "")}>
              <div className="flex items-center gap-2.5">
                <span className={"dot " + (isActivePreset ? "dot-active" : "dot-settled")} style={isActivePreset ? { background: "var(--accent)" } : {}} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13.5px] font-medium">
                    {p.name}
                    <span className="chip !py-0 !text-2xs">{p.kind}</span>
                    {isActivePreset && <span className="chip chip-accent !py-0 !text-2xs">活跃</span>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-2xs text-ghost">
                    {p.baseUrl} · {p.model ?? "—"} · {p.hasApiKey ? `密钥 ${p.apiKeyHint ?? ""}` : "无密钥"}
                  </div>
                </div>
                {!isActivePreset && (
                  <button className="btn" onClick={() => activate(p)}>
                    切换
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-2xs leading-relaxed text-ghost">
        预设 = 协议 + baseUrl + 密钥 + 模型 + 预算的一次性切换(ccswitch 语义)。新增预设由命令行管理,切到这里即刻全局生效。
      </p>
    </>
  )
}

function MemorySection({ s, patch }: { s: EffectiveSettingsView; patch: (p: Partial<Record<string, unknown>>) => void }): React.ReactElement {
  const m = s.memory
  return (
    <>
      <Toggle on={m.on} onChange={(v) => patch({ memory: { ...m, on: v } })} label="语义记忆" hint="会话沉淀可以被检索回注到上下文" />
      <Toggle on={m.extraction} onChange={(v) => patch({ memory: { ...m, extraction: v } })} label="自动提取" hint="回合结束后自动从对话里提取值得记住的内容" />
      <div className="card mt-4 px-4 py-4">
        <div className="label mb-3">向量索引</div>
        <Toggle on={m.vector.enabled} onChange={(v) => patch({ memory: { ...m, vector: { ...m.vector, enabled: v } } })} label="启用向量召回" hint={`当前模式 ${m.vector.mode};关闭时仅用 FTS5 关键词 × cosine 混合`} />
        <Field label="Embedding 模型">
          <input className="input font-mono text-2xs" defaultValue={m.vector.embedding.model} onBlur={(e) => patch({ memory: { ...m, vector: { ...m.vector, embedding: { ...m.vector.embedding, model: e.target.value } } } })} />
        </Field>
        <Field label="Embedding baseUrl">
          <input className="input font-mono text-2xs" defaultValue={m.vector.embedding.baseUrl} onBlur={(e) => patch({ memory: { ...m, vector: { ...m.vector, embedding: { ...m.vector.embedding, baseUrl: e.target.value } } } })} />
        </Field>
        <Field label="Embedding API Key" hint={m.vector.embedding.hasApiKey ? `已配置 ${m.vector.embedding.apiKeyHint ?? ""} · 留空保持不变` : "未配置"}>
          <input
            className="input font-mono text-2xs"
            type="password"
            placeholder={m.vector.embedding.hasApiKey ? "(保持不变)" : "sk-…"}
            onBlur={(e) => e.target.value && patch({ memory: { ...m, vector: { ...m.vector, embedding: { ...m.vector.embedding, apiKey: e.target.value } } } })}
          />
        </Field>
      </div>
    </>
  )
}

function CapabilitySection({ s, patch }: { s: EffectiveSettingsView; patch: (p: Partial<Record<string, unknown>>) => void }): React.ReactElement {
  return (
    <>
      <Toggle on={s.allowBash} onChange={(v) => patch({ allowBash: v })} label="允许执行命令" hint="关闭后 shell 类工具一律拒绝" />
      <Toggle on={s.allowPluginCode} onChange={(v) => patch({ allowPluginCode: v })} label="允许插件代码" hint="插件目录里的 JS 会被加载执行;关闭后只做声明式发现" />
      <div className="card mt-4 px-4 py-4">
        <div className="label mb-2">权限分级</div>
        <p className="text-[13px] leading-relaxed text-dim">
          每个会话可独立选择 strict(每个写入动作都要批准)/ readonly(只读)/ trusted(自动放行),在会话头部随时切换,重启后保持。
        </p>
      </div>
    </>
  )
}

function NetworkSection({ s, patch }: { s: EffectiveSettingsView; patch: (p: Partial<Record<string, unknown>>) => void }): React.ReactElement {
  const [token, setToken] = useState("")
  return (
    <>
      <div className="card mb-4 px-4 py-4">
        <div className="label mb-2">服务地址</div>
        <div className="font-mono text-2xs text-dim">
          http://{s.host}:{s.port}
          <span className="text-ghost"> · 工作区 {s.workspace}</span>
        </div>
      </div>
      <Field label="访问令牌" hint={s.hasToken ? "已设置令牌;输入新值可轮换,留空保持不变" : "未设置;所有请求需带 Bearer token"}>
        <input
          className="input font-mono text-2xs"
          value={token}
          type="password"
          placeholder={s.hasToken ? "(保持不变)" : "设置访问令牌"}
          onChange={(e) => setToken(e.target.value)}
          onBlur={() => token && patch({ token })}
        />
      </Field>
      <Field label="本机存储的令牌" hint="Web 端用它访问服务器;换网络环境时同步修改">
        <input className="input font-mono text-2xs" defaultValue={localStorage.getItem("NEWHORSE_TOKEN") ?? ""} onBlur={(e) => (e.target.value ? localStorage.setItem("NEWHORSE_TOKEN", e.target.value) : localStorage.removeItem("NEWHORSE_TOKEN"))} />
      </Field>
    </>
  )
}

function AppearanceSection(): React.ReactElement {
  const [pref, setPref] = useState<"light" | "dark" | "system">(() => (localStorage.getItem("NEWHORSE_THEME") as "light" | "dark" | "system") ?? "system")
  const apply = (t: "light" | "dark" | "system"): void => {
    localStorage.setItem("NEWHORSE_THEME", t)
    const light = t === "light" || (t === "system" && window.matchMedia("(prefers-color-scheme: light)").matches)
    document.documentElement.dataset.theme = light ? "light" : "dark"
    document.documentElement.style.colorScheme = light ? "light" : "dark"
    setPref(t)
  }
  return (
    <>
      <div className="mb-2 text-[13px] font-medium">主题</div>
      <div className="flex gap-2">
        {(["light", "dark", "system"] as const).map((t) => (
          <button key={t} className={"btn " + (pref === t ? "btn-primary" : "")} onClick={() => apply(t)}>
            {t === "light" ? "浅色" : t === "dark" ? "深色" : "跟随系统"}
          </button>
        ))}
      </div>
      <p className="mt-3 text-2xs text-ghost">深浅两套配色都对齐 ZCode 的中性灰基调;桌面端跟随窗口主题。</p>
    </>
  )
}

function AboutSection({ s }: { s: EffectiveSettingsView }): React.ReactElement {
  return (
    <div className="card px-4 py-4">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold">newhorse</span>
        <span className="chip">agent engine</span>
      </div>
      <p className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-dim">
        模型无关、不绑定任何厂商的常驻智能体引擎:声明式 DAG 调度、可插拔 LLM 路由(openai / openai-compatible / anthropic /
        openai-responses)、事件溯源存储、可扩展插件目录。Web/桌面端只是它的一个传输壳。
      </p>
      <div className="mt-3 font-mono text-2xs text-ghost">agent home · {s.agentHome}</div>
    </div>
  )
}
