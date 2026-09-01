import { useEffect, useState } from "react"
import { Brain, Cpu, Info, Palette, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react"
import { api } from "../api"
import { useStore } from "../store"
import { cycleTheme, getThemePref, type ThemePref } from "../theme"
import { Globe as IconGlobe, Sun as IconSun, Moon as IconMoon, Monitor as IconMonitor } from "lucide-react"
import { IconActivity, IconCheck, IconPencil, IconPlay, IconPlus, IconTrash } from "./icons"

type SectionId = "model" | "budget" | "memory" | "policy" | "network" | "appearance" | "about"

const SECTIONS: Array<{ id: SectionId; label: string; Icon: LucideIcon }> = [
  { id: "model", label: "模型与供应商", Icon: Cpu },
  { id: "memory", label: "记忆", Icon: Brain },
  { id: "policy", label: "权限分级", Icon: ShieldCheck },
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

  // sidebar "连接供应商" CTA jumps straight to the model section
  useEffect(() => {
    const onSection = (e: Event): void => setSection(((e as CustomEvent<string>).detail ?? "model") as SectionId)
    window.addEventListener("nh-settings-section", onSection)
    return () => window.removeEventListener("nh-settings-section", onSection)
  }, [])

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
          {(
            [
              { group: "模型", items: ["model"] },
              { group: "会话能力", items: ["memory", "policy"] },
              { group: "通用", items: ["appearance", "network", "about"] },
            ] as const
          ).map((g) => (
            <div key={g.group} className="flex shrink-0 gap-1 md:contents">
              <div className="hidden px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.12em] text-faint md:block">{g.group}</div>
              {g.items.map((id) => {
                const s = SECTIONS.find((x) => x.id === id)!
                return (
                  <button
                    key={s.id}
                    onClick={() => setSection(s.id)}
                    className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${section === s.id ? "bg-surface2 font-medium text-fg shadow-[inset_0_1px_0_rgba(127,127,127,0.08)]" : "text-dim hover:bg-surface hover:text-fg"}`}
                  >
                    <s.Icon size={15} strokeWidth={1.8} className={section === s.id ? "text-accent" : "opacity-70"} />
                    {s.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        {/* content */}
        <div className="min-w-0 flex-1">
          {err && <div className="mb-3 rounded-xl border border-bad/25 bg-bad/[0.08] px-3.5 py-2.5 text-xs text-bad">{err}</div>}

          {section === "model" && (
            <>
              <ProviderProfiles />
              <Panel title="独立供应商（未启用档案时的兜底）" desc="没有激活任何档案时，新会话使用这里的协议 / 地址 / 密钥与预算。">
                <fieldset disabled={!!settings.activeProviderId} className={settings.activeProviderId ? "pointer-events-none space-y-3 opacity-50" : "space-y-3"}>
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
                  <Field label="模型（也可在输入框胶囊里切换）">
                    <div className="input-base flex items-center !py-0 text-[13px]" style={{ minHeight: 34 }}>
                      {settings.model}
                    </div>
                  </Field>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="上下文窗口（tokens）">
                    <input type="number" className="input-base" defaultValue={settings.contextWindowTokens ?? ""} placeholder="如 128000" onBlur={(e) => patch({ contextWindowTokens: Number(e.target.value) || undefined })} />
                  </Field>
                  <Field label="单次输出上限（tokens）">
                    <input type="number" className="input-base" defaultValue={settings.maxOutputTokens ?? ""} placeholder="如 16384" onBlur={(e) => patch({ maxOutputTokens: Number(e.target.value) || undefined })} />
                  </Field>
                </div>
                <div className="text-[11px] text-faint">压缩触发与折叠尾部随窗口自动缩放；档案激活时以档案内的预算为准。</div>
                {keyInput.trim() && (
                  <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={saving} onClick={() => void saveKey()}>
                    保存 Key
                  </button>
                )}
                {!settings.provider.hasApiKey && !keyInput.trim() && !settings.providers?.length && (
                  <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn">
                    <Info size={13} />
                    尚未设置 API Key——先在上方粘贴一个再保存，模型下拉列表才能拉取。
                  </div>
                )}
                </fieldset>
                {settings.activeProviderId && (
                  <div className="text-[11px] text-faint">档案激活中——这里被档案接管，停用档案后可再编辑。</div>
                )}
              </Panel>
            </>
          )}


          {section === "memory" && (
            <Panel title="记忆" desc="记忆在会话中自动沉淀；语义检索让旧结论能被新任务找回。">
              <div className="grid gap-2.5 md:grid-cols-2">
                <Toggle label="记忆" on={settings.memory.on} onToggle={(v) => patch({ memory: { ...settings.memory, on: v } })} />
                <Toggle label="自动沉淀（提取管线）" on={settings.memory.extraction} onToggle={(v) => patch({ memory: { ...settings.memory, on: v || settings.memory.on, extraction: v } })} />
                <Toggle label="语义检索（向量）" on={settings.memory.vector.enabled} onToggle={(v) => patch({ memory: { ...settings.memory, on: settings.memory.on, vector: { ...settings.memory.vector, enabled: v } } })} />
                <Field label="向量索引">
                  <select
                    className="input-base"
                    value={settings.memory.vector.mode}
                    onChange={(e) => patch({ memory: { ...settings.memory, on: settings.memory.on, vector: { ...settings.memory.vector, mode: e.target.value } } })}
                  >
                    <option value="auto">auto（sqlite-vec，不可用则内存索引）</option>
                    <option value="brute">brute（内存暴力扫描）</option>
                    <option value="off">off（仅关键词 FTS）</option>
                  </select>
                </Field>
              </div>
              {/* embedding endpoint: makes semantic memory configurable from the UI */}
              <div className="mt-3 rounded-xl border border-line bg-surface2/50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">嵌入模型（Embedding）</span>
                  {settings.memory.vector.embedding.hasApiKey && <span className="text-[10.5px] text-ok">Key 已设置 {settings.memory.vector.embedding.apiKeyHint ?? ""}</span>}
                </div>
                <div className="grid gap-2.5 md:grid-cols-2">
                  <Field label="Base URL">
                    <input
                      className="input-base"
                      defaultValue={settings.memory.vector.embedding.baseUrl}
                      placeholder="https://api.minimaxi.com"
                      onBlur={(e) => e.target.value !== settings.memory.vector.embedding.baseUrl && patch({ memory: { ...settings.memory, vector: { ...settings.memory.vector, embedding: { ...settings.memory.vector.embedding, baseUrl: e.target.value } } } })}
                    />
                  </Field>
                  <Field label="模型">
                    <input
                      className="input-base"
                      defaultValue={settings.memory.vector.embedding.model}
                      placeholder="embo-01"
                      onBlur={(e) => e.target.value !== settings.memory.vector.embedding.model && patch({ memory: { ...settings.memory, vector: { ...settings.memory.vector, embedding: { ...settings.memory.vector.embedding, model: e.target.value } } } })}
                    />
                  </Field>
                </div>
                <Field label="API Key（留空保持已存的）">
                  <input
                    className="input-base"
                    type="password"
                    placeholder="粘贴嵌入服务的 Key"
                    autoComplete="off"
                    onBlur={(e) => e.target.value.trim() && patch({ memory: { ...settings.memory, vector: { ...settings.memory.vector, embedding: { ...settings.memory.vector.embedding, apiKey: e.target.value.trim() } } } })}
                  />
                </Field>
                <div className="mt-1 text-[11px] text-faint">更换嵌入模型会重建向量索引；语义检索关闭时这些字段不生效。</div>
              </div>
            </Panel>
          )}

          {section === "policy" && (
            <Panel title="权限分级" desc="默认审批=危险操作弹窗；只读=计划模式；完全访问=跳过审批。可按会话临时切换。">
              <Field label="新会话的默认权限级别">
                <select className="input-base" value={settings.approvalPolicy} onChange={(e) => patch({ approvalPolicy: e.target.value })}>
                  <option value="strict">strict（默认审批）</option>
                  <option value="readonly">readonly（计划模式）</option>
                  <option value="trusted">trusted（完全访问）</option>
                </select>
              </Field>
              <div className="text-[11px] text-faint">
                参照 codex 的三档预设：只读（读文件，写/联网需批准）→ 默认（工作区内写+命令，联网需批准）→ 完全访问。单会话可在会话底部权限胶囊临时切换，写入事件日志。
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
  const [notify, setNotify] = useState(() => localStorage.getItem("NEWHORSE_NOTIFY") === "on" && typeof Notification !== "undefined" && Notification.permission === "granted")
  const toggleNotify = async (): Promise<void> => {
    if (notify) {
      localStorage.setItem("NEWHORSE_NOTIFY", "off")
      setNotify(false)
      return
    }
    if (typeof Notification === "undefined") return
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
    if (perm === "granted") {
      localStorage.setItem("NEWHORSE_NOTIFY", "on")
      setNotify(true)
    }
  }
  return (
    <Panel title="外观" desc="界面明暗与系统提醒；明暗默认跟随操作系统。">
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
      <Toggle label="后台完成时系统通知" on={notify} onToggle={() => void toggleNotify()} />
      <div className="text-[11px] text-faint">会话在后台跑完时发一条系统提醒；需要浏览器授权。</div>
    </Panel>
  )
}

/** A draft being edited in the profile form (id present = editing existing). */
interface ProfileDraft {
  id: string
  name: string
  kind: string
  baseUrl: string
  apiKey: string
  model: string
  contextWindowTokens: string
  maxOutputTokens: string
}

const emptyDraft = (): ProfileDraft => ({ id: crypto.randomUUID(), name: "", kind: "openai-compatible", baseUrl: "", apiKey: "", model: "", contextWindowTokens: "", maxOutputTokens: "" })

/** ccswitch-style provider presets: named, complete, one-click switchable.
 *  A preset carries protocol + baseUrl + key + model + budgets together, so
 *  switching can never leave the window budget behind. Secrets never round-
 *  trip: a blank key field keeps the stored one (server-side merge by id). */
function ProviderProfiles() {
  const { settings, reloadSettings, showToast } = useStore()
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const profiles = settings?.providers ?? []
  const activeId = settings?.activeProviderId
  const activeProfile = profiles.find((p) => p.id === activeId)

  const startEdit = (id: string): void => {
    const p = profiles.find((x) => x.id === id)
    setDraft(
      p
        ? { id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKey: "", model: p.model ?? "", contextWindowTokens: p.contextWindowTokens ? String(p.contextWindowTokens) : "", maxOutputTokens: p.maxOutputTokens ? String(p.maxOutputTokens) : "" }
        : emptyDraft(),
    )
  }

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) {
      showToast("档案需要一个名称")
      return
    }
    const item: Record<string, unknown> = {
      id: draft.id,
      name: draft.name.trim(),
      kind: draft.kind,
      baseUrl: draft.baseUrl.trim() || (draft.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"),
    }
    if (draft.apiKey.trim()) item.apiKey = draft.apiKey.trim() // blank = keep stored key
    // always sent: "" clears a previously stored value (server-side rule);
    // budgets are NUMBERS when set — a string would be dropped by the loader's
    // Number.isFinite guard (silent budget loss).
    item.model = draft.model.trim()
    const ctx = Number(draft.contextWindowTokens)
    item.contextWindowTokens = draft.contextWindowTokens.trim() && Number.isFinite(ctx) ? ctx : ""
    const out = Number(draft.maxOutputTokens)
    item.maxOutputTokens = draft.maxOutputTokens.trim() && Number.isFinite(out) ? out : ""
    try {
      await api.putSettings({ providers: [item] })
      await reloadSettings()
      setDraft(null)
      showToast("档案已保存")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const [testing, setTesting] = useState<string | null>(null)
  /** cc-switch 测试连接: switch to the preset temporarily? No — validate via a
   *  models fetch THROUGH the preset by activating only in-memory is not
   *  possible; instead report what the CURRENT provider can do, plus the
   *  preset's resolved shape. Honest label: 连接测试只对当前启用的供应商有效. */
  const testProvider = async (p: { id: string; name: string }): Promise<void> => {
    setTesting(p.id)
    try {
      if (p.id !== activeId) {
        await api.putSettings({ activeProviderId: p.id })
        await reloadSettings()
      }
      const r = await api.models()
      showToast(r.models.length > 0 ? `${p.name} 连接正常 · ${r.models.length} 个模型` : `${p.name} 已连通，但供应商没有返回模型列表`)
    } catch (e) {
      showToast(`${p.name} 连接失败：${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`)
    } finally {
      setTesting(null)
    }
  }

  const activate = async (id: string): Promise<void> => {
    try {
      await api.putSettings(id === activeId ? { activeProviderId: "" } : { activeProviderId: id })
      await reloadSettings()
      showToast(id === activeId ? "已停用档案（回到独立供应商）" : "档案已启用（新会话生效）")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await api.putSettings({ providersRemove: [id] })
      await reloadSettings()
      if (draft?.id === id) setDraft(null)
      showToast("档案已删除")
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const set = (k: keyof ProfileDraft, v: string): void => setDraft((d) => (d ? { ...d, [k]: v } : d))

  return (
    <Panel title="供应商档案" desc="像 ccswitch 一样把一整套配置命名保存，一键整组切换（协议 + 地址 + 密钥 + 模型 + 预算）。">
      {activeProfile && (
        <div className="flex items-center gap-2 rounded-lg border border-ok/25 bg-ok/[0.07] px-3 py-2 text-[12px] text-ok">
          <IconCheck size={13} />
          当前由档案「{activeProfile.name}」提供配置 · 模型 {settings?.model}
        </div>
      )}
      <div className="space-y-2">
        {profiles.map((p) => (
          <div key={p.id} className={`rounded-xl border p-3 transition-colors ${p.id === activeId ? "border-accent/60 bg-accent/[0.06] shadow-[0_0_0_1px_rgba(61,154,255,0.25)]" : "border-line bg-surface hover:border-linestrong"}`}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{p.name}</span>
              <span className="shrink-0 rounded border border-line bg-surface2 px-1.5 py-0.5 text-[10px] text-faint">{p.kind}</span>
              {p.id === activeId && <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">使用中</span>}
              <button className="nh-icon-btn" title="测试连接：拉取模型列表验证 Key 与地址" onClick={() => void testProvider(p)}>
                <IconActivity size={12} className={testing === p.id ? "animate-pulse" : ""} />
              </button>
              <button className="nh-icon-btn" title={p.id === activeId ? "停用" : "启用此档案"} onClick={() => void activate(p.id)}>
                <IconPlay size={12} />
              </button>
              <button className="nh-icon-btn" title="编辑" onClick={() => startEdit(p.id)}>
                <IconPencil size={12} />
              </button>
              <button className="nh-icon-btn hover:!text-bad" title="删除" onClick={() => void remove(p.id)}>
                <IconTrash size={12} />
              </button>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-faint">
              {p.baseUrl} · {p.model ?? "（跟随独立设置）"}
              {p.hasApiKey ? ` · Key ${p.apiKeyHint ?? "已设置"}` : " · 无 Key"}
              {p.contextWindowTokens ? ` · 窗口 ${p.contextWindowTokens}` : ""}
            </div>
          </div>
        ))}
        {profiles.length === 0 && <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-faint">还没有档案——把你常用的供应商各存一份，切换就不用来回填表了。</div>}
      </div>

      {!draft ? (
        <button className="btn-ghost flex w-full items-center justify-center gap-1.5 !py-2 !text-xs" onClick={() => setDraft(emptyDraft())}>
          <IconPlus size={13} /> 新增供应商档案
        </button>
      ) : (
        <div className="space-y-2.5 rounded-xl border border-linestrong bg-surface2/60 p-3">
          <div className="grid gap-2.5 md:grid-cols-2">
            <Field label="名称">
              <input className="input-base" placeholder="如 DeepSeek 官方" value={draft.name} onChange={(e) => set("name", e.target.value)} autoFocus />
            </Field>
            <Field label="协议">
              <select className="input-base" value={draft.kind} onChange={(e) => set("kind", e.target.value)}>
                {["openai", "openai-compatible", "anthropic", "openai-responses"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-2.5 md:grid-cols-2">
            <Field label="Base URL">
              <input className="input-base" placeholder="https://…" value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
            </Field>
            <Field label="API Key（留空保持已存的）">
              <input className="input-base" type="password" placeholder="粘贴 Key" value={draft.apiKey} onChange={(e) => set("apiKey", e.target.value)} autoComplete="off" />
            </Field>
          </div>
          <div className="grid gap-2.5 md:grid-cols-3">
            <Field label="模型">
              <input className="input-base" placeholder="如 deepseek-chat" value={draft.model} onChange={(e) => set("model", e.target.value)} />
            </Field>
            <Field label="上下文窗口">
              <input type="number" className="input-base" placeholder="如 128000" value={draft.contextWindowTokens} onChange={(e) => set("contextWindowTokens", e.target.value)} />
            </Field>
            <Field label="输出上限">
              <input type="number" className="input-base" placeholder="如 16384" value={draft.maxOutputTokens} onChange={(e) => set("maxOutputTokens", e.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary !px-4 !py-1.5 !text-xs" onClick={() => void save()}>
              保存档案
            </button>
            <button className="btn-ghost !px-4 !py-1.5 !text-xs" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </Panel>
  )
}
