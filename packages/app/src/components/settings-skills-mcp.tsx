import { Button } from "@newhorse/ui/button"
import type { McpStatus } from "@newhorse/sdk/v2"
import { For, Show, createResource, createSignal } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"

function mcpStatusInfo(status: McpStatus): { label: "connected" | "unavailable"; detail?: string } {
  switch (status.status) {
    case "connected":
      return { label: "connected" }
    case "disabled":
      return { label: "unavailable", detail: status.reason }
    case "failed":
      return { label: "unavailable", detail: status.error }
    case "needs_auth":
      return { label: "unavailable", detail: "auth required" }
    case "needs_client_registration":
      return { label: "unavailable", detail: "client registration required" }
  }
}

export function SettingsSkillsMcp() {
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
      title: "Skills & MCP request failed",
      description: formatServerError(error, undefined, "Unknown error"),
    })

  const importSkill = async (file: File) => {
    if (importing()) return
    setImporting(true)
    try {
      const content = await file.text()
      const result = await client()?.skill.import({ content })
      showToast({ variant: "success", title: "Skill imported", description: `Installed "${result?.data?.name ?? file.name}"` })
      refetchSkills()
    } catch (error) {
      fail(error)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-6 py-8">
        <section class="flex flex-col gap-2">
          <h2 class="text-16-medium text-text-strong">Skills &amp; MCP</h2>
          <p class="text-12-regular text-text-weak">
            View loaded skills and connected MCP servers, and import skills from a <code class="text-12-regular">.skill</code> file.
          </p>
          <div class="flex gap-2">
            <Button size="small" onClick={refresh} disabled={skills.loading || mcp.loading}>
              Refresh
            </Button>
            <label class="cursor-pointer">
              <Button size="small" variant="primary" disabled={importing()} onClick={() => {}}>
                {importing() ? "Importing…" : "Import .skill"}
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
          <h3 class="text-16-medium text-text-strong">Skills</h3>
          <Show
            when={!skills.error}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>Skills unavailable.</span>
                <Button size="small" onClick={refresh}>
                  Retry
                </Button>
              </div>
            }
          >
            <Show when={!skills.loading} fallback={<div class="text-12-regular text-text-weak">Loading skills…</div>}>
              <Show
                when={(skills()?.length ?? 0) > 0}
                fallback={<p class="text-12-regular text-text-weak">No skills loaded.</p>}
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
          <h3 class="text-16-medium text-text-strong">MCP servers</h3>
          <Show
            when={!mcp.error}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>MCP servers unavailable.</span>
                <Button size="small" onClick={refresh}>
                  Retry
                </Button>
              </div>
            }
          >
            <Show when={!mcp.loading} fallback={<div class="text-12-regular text-text-weak">Loading MCP servers…</div>}>
              <Show
                when={Object.keys(mcp() ?? {}).length > 0}
                fallback={<p class="text-12-regular text-text-weak">No MCP servers connected.</p>}
              >
                <div class="flex flex-col gap-2">
                  <For each={Object.entries(mcp() ?? {}).toSorted(([a], [b]) => a.localeCompare(b))}>
                    {([name, status]) => {
                      const info = mcpStatusInfo(status)
                      return (
                        <article class="flex items-center justify-between gap-3 rounded-lg bg-surface-base p-4" data-mcp-name={name}>
                          <div class="flex flex-col gap-1">
                            <h4 class="text-14-medium text-text-strong">{name}</h4>
                            <Show when={info.detail}>
                              <p class="text-11-regular text-text-weak">{info.detail}</p>
                            </Show>
                          </div>
                          <span
                            class={
                              info.label === "connected"
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
