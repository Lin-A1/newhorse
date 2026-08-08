import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useSearchParams } from "@solidjs/router"
import { Tooltip } from "@newhorse/ui/tooltip"
import { useDialog } from "@newhorse/ui/context/dialog"
import { Icon as IconV2 } from "@newhorse/ui/v2/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@newhorse/ui/v2/segmented-control-v2"
import { getFilename } from "@newhorse/core/util/path"
import { TooltipV2 } from "@newhorse/ui/v2/tooltip-v2"
import { NewSessionDesignView } from "@/components/session"
import { PromptInputV2Composer, usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { StatusPopoverV2 } from "@/components/status-popover"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  createPromptProjectController,
} from "@/components/prompt-project-selector"
import { useComments } from "@/context/comments"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useConfirm } from "@/components/confirm-dialog"
import { showToast } from "@/utils/toast"
import { errorMessage } from "./layout/helpers"
import { useSettings } from "@/context/settings"
import { createPromptInputController, createPromptProjectControls } from "@/pages/session/composer"
import { useSessionKey } from "@/pages/session/session-layout"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import {
  PromptGitStatus,
  PromptWorkspaceSelector,
  type ProfileOption,
  type WorkspaceAdapterOption,
  type WorkspaceOption,
} from "@/components/prompt-workspace-selector"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useCommand } from "@/context/command"
import { useProviders } from "@/hooks/use-providers"
import { useSettingsCommand } from "@/components/settings-dialog"
import { Persist, persisted } from "@/utils/persist"
import createPresence from "solid-presence"
import { useLocal } from "@/context/local"
import { createPromptModelSelection } from "@/pages/session/composer/prompt-model-selection"

const workspaceBarEnabled = true
const providerTipDismissalDuration = 30 * 24 * 60 * 60 * 1000
const providerTipExitDuration = 250

/**
 * The `/new-session` draft page. Unlike `session.tsx`, this only renders the prompt
 * composer for a brand-new session 闂?no terminal, review pane, file tree, or message
 * timeline. Submitting promotes the draft into a real session (see prompt-input/submit).
 */
export default function NewSessionPage() {
  const prompt = usePrompt()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const comments = useComments()
  const language = useLanguage()
  const settings = useSettings()
  const dialog = useDialog()
  const command = useCommand()
  const providers = useProviders(() => sdk().directory)
  const openProviders = () => {
    void import("@/components/dialog-connect-provider").then(({ DialogConnectProvider }) => {
      void dialog.show(() => <DialogConnectProvider directory={() => sdk().directory} />)
    })
  }
  useSettingsCommand(() => sdk().directory)
  const route = useSessionKey()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const local = useLocal()
  const model = createPromptModelSelection({ agent: local.agent.current })

  useComposerCommands({ model })

  const inputController = createPromptInputController({
    sessionKey: route.sessionKey,
    sessionID: () => route.params.id,
    queryOptions: serverSync().queryOptions,
    model,
  })
  const projectControls = createPromptProjectControls()

  const [store, setStore] = createStore<{ worktree?: string; workspace?: string }>({})
  const [workspaceState, { refetch: refetchWorkspaces }] = createResource(
    () => sdk().directory,
    async () => {
      await sdk()
        .client.experimental.workspace.syncList()
        .catch(() => undefined)
      const [workspaces, adapters] = await Promise.all([
        sdk()
          .client.experimental.workspace.list()
          .then((result) => result.data ?? []),
        sdk()
          .client.experimental.workspace.adapter.list()
          .then((result) => result.data ?? []),
      ])
      return { workspaces: workspaces as WorkspaceOption[], adapters: adapters as WorkspaceAdapterOption[] }
    },
    { initialValue: { workspaces: [] as WorkspaceOption[], adapters: [] as WorkspaceAdapterOption[] } },
  )
  const confirm = useConfirm()
  const removeWorkspace = async (id: string) => {
    const name = workspaceState().workspaces.find((item) => item.id === id)?.name ?? id
    const confirmed = await confirm({
      title: language.t("session.new.workspace.remove.title"),
      message: language.t("session.new.workspace.remove.confirm", { name }),
      confirmLabel: language.t("common.delete"),
      cancelLabel: language.t("common.cancel"),
    })
    if (!confirmed) return
    const removed = await sdk()
      .client.experimental.workspace.remove({ id })
      .then((result) => result.data ?? true)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })
    if (!removed) return
    setStore("workspace", (current) => (current === `workspace:${id}` ? "main" : current))
    void refetchWorkspaces()
  }
  const [profileState] = createResource(
    () => sdk().scope,
    () =>
      sdk()
        .client.global.profile.get()
        .then((result) => result.data),
  )
  const profiles = createMemo(() => (profileState()?.items ?? []) as ProfileOption[])
  const assistantProfileID = createMemo(() => profiles().find((p) => p.kind === "assistant")?.id)
  // Two smart agents on the new-session page: Assistant (session-level work)
  // and newhorse (the continuous companion). Coding chrome (project/workspace/
  // git) only makes sense for Assistant sessions.
  const [mode, setMode] = createSignal<"assistant" | "companion">("assistant")
  const isAssistantProfile = () => mode() === "assistant"
  const selectedWorkspace = createMemo(() => {
    const value = store.workspace
    if (!value?.startsWith("workspace:")) return
    return workspaceState().workspaces.find((item) => item.id === value.slice("workspace:".length))
  })
  createEffect(() => {
    const value = store.workspace
    if (!value?.startsWith("workspace:")) return
    const id = value.slice("workspace:".length)
    if (!workspaceState().workspaces.some((item) => item.id === id)) setStore("workspace", undefined)
  })
  const selectedAdapter = createMemo(() => {
    const value = store.workspace
    return value?.startsWith("adapter:") ? value.slice("adapter:".length) : undefined
  })
  const rightMount = useTitlebarRightMount()

  const showWorkspaceBar = createMemo(() => workspaceBarEnabled && projectControls().available.length > 0)
  const newSessionWorktree = createMemo(() => {
    if (!showWorkspaceBar()) return "main"
    if (store.worktree) return store.worktree
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })
  const workspaceSelection = createMemo(() => store.workspace ?? newSessionWorktree())
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const localBranch = createMemo(() => serverSync().child(projectRoot())[0].vcs?.branch)
  const selectedBranch = createMemo(() => {
    const worktree = newSessionWorktree()
    if (worktree === "main" || worktree === "create") return localBranch()
    return serverSync().child(worktree)[0].vcs?.branch ?? localBranch()
  })
  const promptInputV2Controller = usePromptInputV2Controller({
    get controls() {
      return inputController()
    },
    get newSessionWorktree() {
      return !isAssistantProfile() ? undefined : store.workspace ? "main" : newSessionWorktree()
    },
    get newSessionWorkspaceID() {
      return isAssistantProfile() ? selectedWorkspace()?.id : undefined
    },
    get newSessionWorkspaceType() {
      return isAssistantProfile() ? selectedAdapter() : undefined
    },
    get newSessionWorkspaceDirectory() {
      return isAssistantProfile() ? (selectedWorkspace()?.directory ?? undefined) : undefined
    },
    get newSessionProfileID() {
      return mode() === "companion" ? "companion" : assistantProfileID()
    },
    onNewSessionWorktreeReset: () => setStore({ worktree: undefined, workspace: undefined }),
    onSubmit: () => comments.clear(),
  })
  const projectController = createPromptProjectController({
    controls: projectControls,
    onDone: promptInputV2Controller.restoreFocus,
  })

  command.register("new-session", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const { DialogSelectFile } = await import("@/components/dialog-select-file")
        void dialog.show(() => <DialogSelectFile />)
      },
    },
    {
      id: "input.focus",
      title: language.t("command.input.focus"),
      category: language.t("command.category.view"),
      keybind: "ctrl+l",
      onSelect: () => promptInputV2Controller.restoreFocus(),
    },
  ])

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  createEffect(() => {
    if (!prompt.ready()) return
    promptInputV2Controller.restoreFocus()
  })

  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => prompt.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Show when={settings.visibility.status()}>
              <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                <StatusPopoverV2 workspaceID={() => selectedWorkspace()?.id} />
              </Tooltip>
            </Show>
          </Portal>
        )}
      </Show>
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <div class="@container relative flex flex-col min-h-0 h-full flex-1">
          <div class="flex-1 min-h-0 overflow-hidden rounded-[10px]">
            <NewSessionDesignView>
              <div class={NEW_SESSION_CONTENT_WIDTH}>
                <div class="flex flex-col gap-8">
                  <AssistantStatusBar
                    agent={() => (mode() === "companion" ? language.t("newSession.mode.companion") : local.agent.current()?.name)}
                    model={() => (mode() === "assistant" ? local.model.current()?.name : undefined)}
                    project={() => (mode() === "assistant" ? getFilename(projectRoot()) : undefined)}
                  />
                  <div class="flex items-center justify-center">
                    <SegmentedControlV2
                      value={mode()}
                      onChange={(value) => {
                        const next = value === "companion" ? "companion" : "assistant"
                        setMode(next)
                        if (next === "companion") setStore({ workspace: undefined, worktree: undefined })
                      }}
                    >
                      <SegmentedControlItemV2 value="assistant">
                        {language.t("newSession.mode.assistant")}
                      </SegmentedControlItemV2>
                      <SegmentedControlItemV2 value="companion">
                        {language.t("newSession.mode.companion")}
                      </SegmentedControlItemV2>
                    </SegmentedControlV2>
                  </div>
                  <PromptInputV2Composer controller={promptInputV2Controller} />
                  <Show when={isAssistantProfile() && projectController.empty()}>
                    <PromptProjectAddButton controller={projectController} />
                  </Show>
                  <Show when={isAssistantProfile() && projectController.selected()}>
                    <div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">
                      <PromptProjectSelector controller={projectController} placement="bottom" />
                      <Show
                        when={showWorkspaceBar()}
                        fallback={<PromptGitStatus branch={selectedBranch()} noGit={sync().project?.vcs !== "git"} />}
                      >
                        <PromptWorkspaceSelector
                          value={workspaceSelection()}
                          projectRoot={projectRoot()}
                          workspaces={sync().project?.sandboxes ?? []}
                          workspaceOptions={workspaceState().workspaces}
                          adapterOptions={workspaceState().adapters}
                          branch={selectedWorkspace()?.branch ?? selectedBranch()}
                          onChange={(value) => {
                            if (value.startsWith("workspace:") || value.startsWith("adapter:")) {
                              setStore({ workspace: value, worktree: undefined })
                              return
                            }
                            setStore({
                              workspace: undefined,
                              worktree:
                                value === "main" && sync().project?.worktree !== sdk().directory
                                  ? sync().project?.worktree
                                  : value,
                            })
                          }}
                          onDone={promptInputV2Controller.restoreFocus}
                          onRemoveWorkspace={removeWorkspace}
                        />
                      </Show>
                    </div>
                  </Show>
                </div>
                {/*</Show>*/}
              </div>
            </NewSessionDesignView>
            <ProviderTip
              ready={() => serverSync().child(sdk().directory)[0].provider_ready}
              connected={() => providers.paid().length > 0}
              openProviders={openProviders}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function ProviderTip(props: { ready: () => boolean; connected: () => boolean; openProviders: () => void }) {
  const language = useLanguage()
  const [persistedState, setPersistedState, , persistedReady] = persisted(
    Persist.global("new-session.provider-tip"),
    createStore({ dismissedAt: 0 }),
  )
  const visible = createMemo(
    () =>
      props.ready() &&
      persistedReady() &&
      !props.connected() &&
      Date.now() - persistedState.dismissedAt >= providerTipDismissalDuration,
  )

  function dismiss() {
    setPersistedState("dismissedAt", Date.now())
  }

  const [ref, setRef] = createSignal<HTMLDivElement>()
  const presence = createPresence({
    show: () => visible(),
    element: () => ref() ?? null,
  })

  return (
    <Show when={presence.present()}>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-10">
        <div
          ref={setRef}
          data-component="provider-tip"
          data-visible={visible()}
          class="group/provider-tip pointer-events-auto relative flex h-6 max-w-full items-center transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:transition-none"
          classList={{
            "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": true,
          }}
        >
          <button
            type="button"
            class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-none tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"
            onClick={props.openProviders}
          >
            <span class="truncate">{language.t("home.providerTip")}</span>
            <span class="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <IconV2 name="chevron-down" size="small" class="-rotate-90" />
            </span>
          </button>
          <TooltipV2
            class="hover-reveal absolute left-full top-0 flex h-6 w-7 items-center justify-end delay-0 duration-0 group-hover/provider-tip:delay-[250ms] group-hover/provider-tip:duration-150 group-hover/provider-tip:opacity-100 focus-within:delay-0 focus-within:duration-0 focus-within:opacity-100"
            placement="top"
            openDelay={1000}
            value={language.t("common.dismiss")}
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none"
              aria-label={language.t("common.dismiss")}
              onClick={dismiss}
            >
              <IconV2 name="xmark-small" />
            </button>
          </TooltipV2>
        </div>
      </div>
    </Show>
  )
}

const NEWHORSE_ASCII = [
  "██      ██  ██████████  ██      ██  ██      ██  ██████████  ████████    ██████████  ██████████",
  "████    ██  ██          ██      ██  ██      ██  ██      ██  ██      ██  ██          ██",
  "██  ██  ██  ████████    ██  ██  ██  ██████████  ██      ██  ██████      ████████    ████████",
  "██    ████  ██          ████  ████  ██      ██  ██      ██  ██  ██              ██  ██",
  "██      ██  ██████████  ██      ██  ██      ██  ██████████  ██    ██    ██████████  ██████████",
].join("\n")

function AssistantStatusBar(props: {
  agent: () => string | undefined
  model: () => string | undefined
  project: () => string | undefined
}) {
  const language = useLanguage()
  return (
    <div class="flex flex-col items-center gap-3" data-slot="assistant-status-bar">
      <pre
        aria-hidden="true"
        class="max-w-full select-none overflow-hidden font-mono text-[11px] leading-[1.15] tracking-tight"
        style={{
          "background-image": "linear-gradient(180deg, #ffffff 0%, #d2d2d2 45%, #858585 100%)",
          "-webkit-background-clip": "text",
          "background-clip": "text",
          color: "transparent",
        }}
      >
        {NEWHORSE_ASCII}
      </pre>
      <div class="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[13px] leading-none text-v2-text-text-muted">
        <span class="font-medium text-v2-text-text-base">
          {props.agent() ?? language.t("command.category.agent")}
        </span>
        <Show when={props.model()}>
          <span aria-hidden="true">·</span>
          <span class="max-w-[200px] truncate">{props.model()}</span>
        </Show>
        <Show when={props.project()}>
          <span aria-hidden="true">·</span>
          <span class="max-w-[200px] truncate">{props.project()}</span>
        </Show>
      </div>
    </div>
  )
}
