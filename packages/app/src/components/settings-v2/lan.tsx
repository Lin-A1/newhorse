import { Component, createSignal, createResource, For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@newhorse/ui/v2/button-v2"
import { TextInputV2 } from "@newhorse/ui/v2/text-input-v2"
import { Switch } from "@newhorse/ui/v2/switch-v2"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import "./settings-v2.css"

type LanForm = {
  enabled: boolean
  password: string
  port: string
}

async function copyText(value: string): Promise<boolean> {
  // Prefer the main-process clipboard: navigator.clipboard.writeText and the
  // deprecated document.execCommand("copy") both fail intermittently inside the
  // Electron renderer (no document focus, or secure-context restriction).
  try {
    if (typeof window !== "undefined" && window.api?.writeClipboardText) {
      const ok = await window.api.writeClipboardText(value)
      if (ok) return true
    }
  } catch {
    // fall through to renderer-side attempts
  }
  if (typeof document === "undefined") return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fall through
  }
  try {
    const body = document.body
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  } catch {
    // ignore
  }
  return false
}

function withToken(host: string, port: number, password: string | null) {
  const base = `http://${host}:${port}`
  if (!password) return base
  try {
    return `${base}/?auth_token=${encodeURIComponent(btoa(`opencode:${password}`))}`
  } catch {
    return base
  }
}

export const SettingsLanV2: Component = () => {
  const [form, setForm] = createStore<LanForm>({ enabled: false, password: "", port: "" })
  const [loaded, setLoaded] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [needsRelaunch, setNeedsRelaunch] = createSignal(false)
  const [message, setMessage] = createSignal<string>("")
  const [ips] = createResource(() => window.api?.getNetworkIps?.() ?? [])
  const [theConfig, { refetch: refetchConfig }] = createResource(() => window.api?.getLanConfig?.() ?? null)
  const api = () => Boolean(window.api?.getLanConfig && window.api?.setLanConfig)

  onMount(async () => {
    const c = await window.api?.getLanConfig?.()
    if (!c) return
    setForm({
      enabled: c.enabled,
      password: c.password ?? "",
      port: c.port ? String(c.port) : "",
    })
    setNeedsRelaunch(false)
    setLoaded(true)
  })

  const canSave = () => {
    if (!form.enabled) return true
    if (!form.password) return false
    if (form.port && !/^\d{1,5}$/.test(form.port)) return false
    return true
  }

  const save = async () => {
    if (!canSave()) {
      setMessage("cannotEnable")
      return
    }
    setMessage("")
    const port = form.port ? Number.parseInt(form.port, 10) : null
    await window.api?.setLanConfig?.({
      enabled: form.enabled,
      password: form.password || null,
      port: form.enabled ? port : null,
    })
    setDirty(false)
    setNeedsRelaunch(true)
    void refetchConfig()
  }

  const generatePassword = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    let out = ""
    const bytes = new Uint8Array(24)
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes)
    for (const byte of bytes) out += chars[byte % chars.length]
    setForm("password", out)
    setDirty(true)
  }

  const applied = () => theConfig.latest?.enabled ?? false

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">局域网 / 手机访问</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-lan">
        <Show when={loaded()}>
          <div class="settings-v2-section">
            <SettingsListV2>
              <SettingsRowV2 title="局域网访问" description="允许局域网内的手机 / 电脑通过浏览器访问并收发消息。">
                <Switch
                  checked={form.enabled}
                  disabled={!api()}
                  onChange={(checked) => {
                    if (checked && !form.password) {
                      setMessage("cannotEnable")
                      return
                    }
                    setMessage("")
                    setForm("enabled", checked)
                    setDirty(true)
                  }}
                />
              </SettingsRowV2>

              <SettingsRowV2
                title="访问密码"
                description="必须设置密码才能开启局域网访问；关闭后回退为仅本机随机密码。"
              >
                <div class="flex w-full gap-2 items-center sm:w-auto">
                  <TextInputV2
                    type="text"
                    appearance="base"
                    value={form.password}
                    onInput={(event) => {
                      setForm("password", event.currentTarget.value)
                      setDirty(true)
                    }}
                    placeholder="设置访问密码"
                    spellcheck={false}
                    autocomplete="off"
                    class="min-w-0 flex-1"
                  />
                  <ButtonV2 variant="neutral" size="small" onClick={generatePassword} class="shrink-0">
                    生成
                  </ButtonV2>
                </div>
              </SettingsRowV2>

              <SettingsRowV2 title="端口" description="局域网访问使用的端口；留空时自动选择随机端口。">
                <div class="w-full sm:w-[180px]">
                  <TextInputV2
                    type="number"
                    appearance="base"
                    value={form.port}
                    onInput={(event) => {
                      setForm("port", event.currentTarget.value)
                      setDirty(true)
                    }}
                    placeholder="自动"
                  />
                </div>
              </SettingsRowV2>
            </SettingsListV2>

            <Show when={message() === "cannotEnable"}>
              <p class="settings-v2-lan-message">请先设置访问密码。</p>
            </Show>

            <Show when={dirty() && canSave()}>
              <div class="settings-v2-lan-actions">
                <ButtonV2 variant="contrast" size="normal" onClick={() => void save()}>
                  保存
                </ButtonV2>
              </div>
            </Show>
          </div>

          <Show when={applied() && Boolean(theConfig.latest?.port)}>
            <div class="settings-v2-section">
              <h3 class="settings-v2-section-title">访问地址</h3>
              <SettingsListV2>
                <SettingsRowV2
                  title="局域网地址"
                  description="局域网设备浏览器打开（已含自动登录令牌 auth_token）。"
                >
                  <ul class="settings-v2-lan-urls">
                    <For
                      each={ips()}
                      fallback={<li class="settings-v2-lan-empty">未检测到局域网 IPv4 地址</li>}
                    >
                      {(ip) => {
                        const cfg = theConfig.latest
                        const port = cfg?.port ?? 0
                        const url = withToken(ip, port, cfg?.password ?? null)
                        return (
                          <li>
                            <span class="settings-v2-lan-url">{url}</span>
                            <ButtonV2
                              variant="neutral"
                              size="small"
                              class="shrink-0"
                              onClick={() => {
                                void copyText(url).then((ok) => {
                                  showToast({
                                    title: ok ? "已复制" : "复制失败",
                                    description: ok ? url : "请手动选择文本并复制",
                                  })
                                })
                              }}
                            >
                              复制
                            </ButtonV2>
                          </li>
                        )
                      }}
                    </For>
                  </ul>
                </SettingsRowV2>
              </SettingsListV2>
              <p class="settings-v2-lan-status">
                {needsRelaunch() ? "状态：重启中，重新启动应用后生效。" : "状态：已生效。"}
                若手机无法访问，请检查 Windows 防火墙是否允许本应用。
              </p>
            </div>
          </Show>
        </Show>
      </div>
    </>
  )
}
