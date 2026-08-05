import { Button } from "@newhorse/ui/button"
import { Dialog } from "@newhorse/ui/dialog"
import { Icon } from "@newhorse/ui/icon"
import { Select } from "@newhorse/ui/select"
import { TextField } from "@newhorse/ui/text-field"
import { useDialog } from "@newhorse/ui/context/dialog"
import type { McpStatus } from "@newhorse/sdk/v2"
import { For, Show, createResource, createSignal } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"

function mcpStatusInfo(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  status: McpStatus,
): { label: string; detail?: string } {
  switch (status.status) {
    case "connected":
      return { label: t("settings.skillsMcp.status.connected") }
    case "disabled":
      return { label: t("settings.skillsMcp.status.unavailable"), detail: status.reason }
    case "failed":
      return { label: t("settings.skillsMcp.status.unavailable"), detail: status.error }
    case "needs_auth":
      return { label: t("settings.skillsMcp.status.unavailable"), detail: t("settings.skillsMcp.status.authRequired") }
    case "needs_client_registration":
      return {
        label: t("settings.skillsMcp.status.unavailable"),
        detail: t("settings.skillsMcp.status.clientRegistrationRequired"),
      }
    default:
      return { label: t("settings.skillsMcp.status.unavailable") }
  }
}

function skillSource(location: string): { remote: boolean; label: string } {
  if (/^https?:\/\//i.test(location)) {
    try {
      return { remote: true, label: new URL(location).host }
    } catch {
      return { remote: true, label: location }
    }
  }
  const parts = location.replace(/\\/g, "/").split("/").filter(Boolean)
  return { remote: false, label: parts[parts.length - 1] ?? location }
}

export function SettingsSkillsMcp() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const [importing, setImporting] = createSignal(false)
  let skillFileInput: HTMLInputElement | undefined

  const client = () => serverSDK().client

  const [skills, { refetch: refetchSkills }] = createResource(async () => {
    const res = await client()?.app.skills()
    return res?.data ?? []
  })
  const [mcp, { refetch: refetchMcp }] = createResource(async () => {
    const res = await client()?.mcp.status()
    return res?.data ?? {}
  })

  const refresh = () => {
    refetchSkills()
    refetchMcp()
  }

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.skillsMcp.title"),
      description: formatServerError(error, undefined, language.t("common.requestFailed")),
    })

  const importSkill = async (file: File) => {
    if (importing()) return
    setImporting(true)
    try {
      const content = await file.text()
      const result = await client()?.skill.import({ content })
      showToast({
        variant: "success",
        title: language.t("settings.skillsMcp.title"),
        description: language.t("settings.skillsMcp.imported", { name: result?.data?.name ?? file.name }),
      })
      refetchSkills()
    } catch (error) {
      fail(error)
    } finally {
      setImporting(false)
    }
  }

  const skillFile = ".skill"

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-6 py-8">
        <section class="flex flex-col gap-2">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.skillsMcp.title")}</h2>
          <p class="text-12-regular text-text-weak">
            {language.t("settings.skillsMcp.description", { file: skillFile })}
          </p>
          <div class="flex gap-2">
            <Button size="small" onClick={refresh} disabled={skills.loading || mcp.loading}>
              {language.t("common.refresh")}
            </Button>
            <Button
              size="small"
              variant="primary"
              disabled={importing()}
              onClick={() => skillFileInput?.click()}
            >
              {importing() ? language.t("common.importing") : language.t("settings.skillsMcp.import", { file: skillFile })}
            </Button>
            <input
              ref={(el) => (skillFileInput = el)}
              type="file"
              accept=".skill,.md,.markdown,text/markdown"
              class="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ""
                if (file) void importSkill(file)
              }}
            />
          </div>
        </section>

        <section class="flex flex-col gap-3" data-settings-section="skills">
          <div class="flex flex-col gap-1">
            <h3 class="text-16-medium text-text-strong">{language.t("settings.skillsMcp.skills.title")}</h3>
            <p class="text-12-regular text-text-weak">{language.t("settings.skillsMcp.skills.help")}</p>
          </div>
          <Show
            when={!skills.error}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>{language.t("settings.skillsMcp.skills.unavailable")}</span>
                <Button size="small" onClick={refresh}>
                  {language.t("common.retry")}
                </Button>
              </div>
            }
          >
            <Show when={!skills.loading} fallback={<div class="text-12-regular text-text-weak">{language.t("settings.skillsMcp.skills.loading")}</div>}>
              <Show
                when={(skills()?.length ?? 0) > 0}
                fallback={<p class="text-12-regular text-text-weak">{language.t("settings.skillsMcp.skills.empty")}</p>}
              >
                <div class="flex flex-col gap-2">
                  <For each={skills()}>
                    {(skill) => {
                      const source = skillSource(skill.location)
                      return (
                        <article class="flex flex-col gap-1.5 rounded-lg bg-surface-base p-4" data-skill-name={skill.name}>
                          <div class="flex items-center justify-between gap-2">
                            <h4 class="text-14-medium text-text-strong">{skill.name}</h4>
                            <span class="flex shrink-0 items-center gap-1 rounded-full bg-surface-raised-base px-2 py-0.5 text-11-regular text-text-weak">
                              <Icon name={source.remote ? "link" : "folder"} size="small" />
                              {source.remote
                                ? language.t("settings.skillsMcp.skills.source.remote")
                                : language.t("settings.skillsMcp.skills.source.local")}
                            </span>
                          </div>
                          <Show when={skill.description}>
                            <p class="whitespace-pre-wrap text-13-regular text-text-base">{skill.description}</p>
                          </Show>
                          <p class="truncate text-11-regular text-text-weaker">{source.label}</p>
                        </article>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </section>

        <section class="flex flex-col gap-3" data-settings-section="mcp">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-16-medium text-text-strong">{language.t("settings.skillsMcp.mcp.title")}</h3>
            <Button size="small" variant="secondary" icon="plus" onClick={() => void dialog.show(() => <DialogAddMcp onAdded={refresh} />)}>
              {language.t("settings.skillsMcp.mcp.add.button")}
            </Button>
          </div>
          <Show
            when={!mcp.error}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>{language.t("settings.skillsMcp.mcp.unavailable")}</span>
                <Button size="small" onClick={refresh}>
                  {language.t("common.retry")}
                </Button>
              </div>
            }
          >
            <Show when={!mcp.loading} fallback={<div class="text-12-regular text-text-weak">{language.t("settings.skillsMcp.mcp.loading")}</div>}>
              <Show
                when={Object.keys(mcp() ?? {}).length > 0}
                fallback={<p class="text-12-regular text-text-weak">{language.t("settings.skillsMcp.mcp.empty")}</p>}
              >
                <div class="flex flex-col gap-2">
                  <For each={Object.entries(mcp() ?? {}).toSorted(([a], [b]) => a.localeCompare(b))}>
                    {([name, status]) => {
                      const info = mcpStatusInfo(language.t, status)
                      return (
                        <article
                          class="flex items-center justify-between gap-3 rounded-lg bg-surface-base p-4"
                          data-mcp-name={name}
                        >
                          <div class="flex flex-col gap-1">
                            <h4 class="text-14-medium text-text-strong">{name}</h4>
                            <Show when={info.detail}>
                              <p class="text-11-regular text-text-weak">{info.detail}</p>
                            </Show>
                          </div>
                          <span
                            class={
                              info.label === language.t("settings.skillsMcp.status.connected")
                                ? "text-12-regular text-positive"
                                : "text-12-regular text-negative"
                            }
                          >
                            {info.label}
                          </span>
                        </article>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </section>
      </div>
    </div>
  )
}

function DialogAddMcp(props: { onAdded: () => void }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const [name, setName] = createSignal("")
  const [type, setType] = createSignal<"local" | "remote">("local")
  const [config, setConfig] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const submit = async () => {
    const trimmedName = name().trim()
    const trimmedConfig = config().trim()
    if (!trimmedName || !trimmedConfig) return
    setAdding(true)
    setError("")
    try {
      const mcpConfig =
        type() === "local"
          ? { type: "local" as const, command: trimmedConfig.split(/\s+/).filter(Boolean), environment: {} }
          : { type: "remote" as const, url: trimmedConfig, headers: {} }
      const res = await serverSDK().client.mcp.add({ name: trimmedName, config: mcpConfig })
      if (!res.data) throw new Error(language.t("settings.skillsMcp.mcp.add.failed"))
      dialog.close()
      props.onAdded()
    } catch (err) {
      setError(formatServerError(err, undefined, language.t("common.requestFailed")))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog title={language.t("settings.skillsMcp.mcp.add.title")}>
      <div class="flex flex-col gap-3">
        <TextField
          label={language.t("settings.skillsMcp.mcp.add.name")}
          value={name()}
          onChange={setName}
          placeholder="e.g. filesystem"
        />
        <Select
          options={["local", "remote"] as const}
          current={type()}
          label={(value) =>
            value === "local"
              ? language.t("settings.skillsMcp.mcp.add.type.local")
              : language.t("settings.skillsMcp.mcp.add.type.remote")
          }
          onSelect={(value) => value && setType(value)}
          variant="secondary"
          size="small"
        />
        <TextField
          label={
            type() === "local"
              ? language.t("settings.skillsMcp.mcp.add.command")
              : language.t("settings.skillsMcp.mcp.add.url")
          }
          value={config()}
          onChange={setConfig}
          placeholder={
            type() === "local" ? "npx -y @modelcontextprotocol/server-filesystem" : "https://example.com/mcp"
          }
        />
        <Show when={error()}>
          <p class="text-12-regular text-negative">{error()}</p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button size="small" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            size="small"
            variant="primary"
            disabled={adding() || !name().trim() || !config().trim()}
            onClick={() => void submit()}
          >
            {language.t("settings.skillsMcp.mcp.add.submit")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
