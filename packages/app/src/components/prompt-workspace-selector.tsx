import { For, Show } from "solid-js"
import { MenuV2 } from "@newhorse/ui/v2/menu-v2"
import { TooltipV2 } from "@newhorse/ui/v2/tooltip-v2"
import { Icon } from "@newhorse/ui/icon"
import { Icon as IconV2 } from "@newhorse/ui/v2/icon"
import { getFilename } from "@newhorse/core/util/path"
import { useLanguage } from "@/context/language"

export type WorkspaceOption = {
  id: string
  type: string
  name: string
  branch?: string | null
  directory?: string | null
}

export type WorkspaceAdapterOption = {
  type: string
  name: string
}

export type ProfileOption = {
  id: string
  kind: "assistant" | "companion"
  name: string
  memory: "off" | "ask" | "auto-safe"
  proactive: boolean
}

export function PromptProfileSelector(props: {
  value: string
  profiles: ProfileOption[]
  onChange: (value: string) => void
  onDone: () => void
}) {
  const language = useLanguage()
  let pending: string | undefined
  const selected = () => props.profiles.find((profile) => profile.id === props.value) ?? props.profiles[0]
  const onOpenChange = (open: boolean) => {
    if (open) return
    const value = pending
    pending = undefined
    if (value) props.onChange(value)
    props.onDone()
  }

  return (
    <>
      <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      <MenuV2 placement="bottom" gutter={4} onOpenChange={onOpenChange}>
        <MenuV2.Trigger class="flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-muted">
          <IconV2 name="user" class="shrink-0 text-v2-icon-icon-muted" />
          <span class="min-w-0 truncate">{selected()?.name ?? language.t("command.category.agent")}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="w-[200px]">
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("command.category.agent")}</MenuV2.GroupLabel>
              <For each={props.profiles}>
                {(profile) => (
                  <MenuV2.Item onSelect={() => (pending = profile.id)}>
                    <IconV2 name="user" />
                    <span class="min-w-0 flex-1 truncate">{profile.name}</span>
                    <Show when={props.value === profile.id}>
                      <Icon name="check" size="small" class="shrink-0" />
                    </Show>
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </>
  )
}

export function PromptWorkspaceSelector(props: {
  value: string
  projectRoot: string
  workspaces: string[]
  workspaceOptions?: WorkspaceOption[]
  adapterOptions?: WorkspaceAdapterOption[]
  branch?: string
  onChange: (value: string) => void
  onDone: () => void
}) {
  const language = useLanguage()
  let pending: string | undefined
  const selected = () => (props.value === props.projectRoot ? "main" : props.value)
  const selectedWorkspace = () => props.workspaceOptions?.find((item) => selected() === `workspace:${item.id}`)
  const selectedAdapter = () => props.adapterOptions?.find((item) => selected() === `adapter:${item.type}`)
  const icon = () => {
    if (selected() === "main") return "monitor"
    if (selected() === "create" || selectedAdapter()) return "workspace-new"
    return "workspace"
  }
  const select = (value: string) => {
    pending = value
  }
  const onOpenChange = (open: boolean) => {
    if (open) return
    const value = pending
    pending = undefined
    if (value) props.onChange(value)
    props.onDone()
  }
  const label = () => {
    if (selected() === "main") return language.t("session.new.workspace.triggerLocal")
    if (props.value === "create") return language.t("workspace.new")
    if (selectedWorkspace()) return selectedWorkspace()!.name
    if (selectedAdapter()) return selectedAdapter()!.name
    return getFilename(props.value)
  }

  return (
    <>
      <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      <MenuV2 placement="bottom" gutter={4} onOpenChange={onOpenChange}>
        <MenuV2.Trigger class="flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-muted">
          <IconV2 name={icon()} class="shrink-0 text-v2-icon-icon-muted" />
          <span class="min-w-0 truncate">{label()}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="w-[180px]">
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("session.new.workspace.runIn")}</MenuV2.GroupLabel>
              <MenuV2.Item onSelect={() => select("main")}>
                <IconV2 name="monitor" />
                <span class="min-w-0 flex-1 truncate">{language.t("session.new.workspace.local")}</span>
                <Show when={selected() === "main"}>
                  <Icon name="check" size="small" class="shrink-0" />
                </Show>
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => select("create")}>
                <IconV2 name="workspace-new" />
                <span class="min-w-0 flex-1 truncate">{language.t("workspace.new")}</span>
                <Show when={selected() === "create"}>
                  <Icon name="check" size="small" class="shrink-0" />
                </Show>
              </MenuV2.Item>
              <For each={props.adapterOptions?.filter((adapter) => adapter.type === "personal") ?? []}>
                {(adapter) => (
                  <MenuV2.Item onSelect={() => select(`adapter:${adapter.type}`)}>
                    <IconV2 name="workspace-new" />
                    <span class="min-w-0 flex-1 truncate">{adapter.name}</span>
                    <Show when={selected() === `adapter:${adapter.type}`}>
                      <Icon name="check" size="small" class="shrink-0" />
                    </Show>
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
            <Show when={(props.workspaceOptions?.length ?? 0) > 0}>
              <MenuV2.Separator />
              <MenuV2.Group>
                <MenuV2.GroupLabel>{language.t("session.new.workspace.existing")}</MenuV2.GroupLabel>
                <For each={props.workspaceOptions ?? []}>
                  {(workspace) => (
                    <MenuV2.Item onSelect={() => select(`workspace:${workspace.id}`)}>
                      <IconV2 name="workspace-isolated" />
                      <span class="min-w-0 flex-1 truncate">{workspace.name}</span>
                      <Show when={selected() === `workspace:${workspace.id}`}>
                        <Icon name="check" size="small" class="shrink-0" />
                      </Show>
                    </MenuV2.Item>
                  )}
                </For>
              </MenuV2.Group>
            </Show>
            <Show when={props.workspaces.length > 0}>
              <MenuV2.Separator />
              <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
                <MenuV2.SubTrigger>
                  <IconV2 name="workspace" />
                  {language.t("session.new.workspace.existing")}
                </MenuV2.SubTrigger>
                <MenuV2.Portal>
                  <MenuV2.SubContent class="max-w-[200px]">
                    <For each={props.workspaces}>
                      {(workspace) => (
                        <MenuV2.Item onSelect={() => select(workspace)}>
                          <IconV2 name="workspace-isolated" />
                          <span class="min-w-0 flex-1 truncate">{getFilename(workspace)}</span>
                          <Show when={selected() === workspace}>
                            <Icon name="check" size="small" class="shrink-0" />
                          </Show>
                        </MenuV2.Item>
                      )}
                    </For>
                  </MenuV2.SubContent>
                </MenuV2.Portal>
              </MenuV2.Sub>
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <PromptGitStatus branch={props.branch} />
    </>
  )
}

export function PromptGitStatus(props: { branch?: string; noGit?: boolean }) {
  const language = useLanguage()
  const label = () => {
    if (props.noGit) return language.t("session.new.git.none")
    return props.branch
  }

  return (
    <Show when={label()}>
      {(value) => (
        <>
          <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
          <TooltipV2
            placement="top"
            value={value()}
            class="min-w-0 max-w-[220px]"
            contentClass="max-w-[calc(100vw-32px)] break-all"
          >
            <div class="flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px]">
              <Icon name="branch" size="small" class="shrink-0 text-v2-icon-icon-muted" />
              <span class="min-w-0 truncate">{value()}</span>
            </div>
          </TooltipV2>
        </>
      )}
    </Show>
  )
}
