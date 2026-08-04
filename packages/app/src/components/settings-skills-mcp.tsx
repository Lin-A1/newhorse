import { Button } from "@newhorse/ui/button"
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
  }
}

export function SettingsSkillsMcp() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [importing, setImporting] = createSignal(false)

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
            <label class="cursor-pointer">
              <Button size="small" variant="primary" disabled={importing()} onClick={() => {}}>
                {importing() ? language.t("common.importing") : language.t("settings.skillsMcp.import", { file: skillFile })}
              </Button>
              <input
                type="file"
                accept=".skill,.md,.markdown,text/markdown"
                class="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ""
                  if (file) void importSkill(file)
                }}
              />
            </label>
          </div>
        </section>

        <section class="flex flex-col gap-3" data-settings-section="skills">
          <h3 class="text-16-medium text-text-strong">{language.t("settings.skillsMcp.skills.title")}</h3>
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
                    {(skill) => (
                      <article class="flex flex-col gap-1 rounded-lg bg-surface-base p-4" data-skill-name={skill.name}>
                        <h4 class="text-14-medium text-text-strong">{skill.name}</h4>
                        <Show when={skill.description}>
                          <p class="whitespace-pre-wrap text-13-regular text-text-base">{skill.description}</p>
                        </Show>
                        <p class="text-11-regular text-text-weak">{skill.location}</p>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </section>

        <section class="flex flex-col gap-3" data-settings-section="mcp">
          <h3 class="text-16-medium text-text-strong">{language.t("settings.skillsMcp.mcp.title")}</h3>
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
