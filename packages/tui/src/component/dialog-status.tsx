import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { For, Show, createMemo, createResource, onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"

export type DialogStatusProps = {}

export function DialogStatus() {
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const { theme } = useTheme()
  const dialog = useDialog()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const [capability] = createResource(() =>
    sdk
      .clientFor(project.workspace.current())
      .capability.get(undefined, { signal: controller.signal })
      .then((response) => response.data),
  )

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))
  const pluginCount = createMemo(() => capability()?.plugins.loaded ?? 0)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={capability()}>
        {(status) => (
          <box>
            <text fg={theme.text}>
              {status().profile.name} · {status().workspace.contentScope} scope
            </text>
            <text fg={theme.textMuted}>
              {status().tools.length} tools · {status().skills.length} skills · {status().agent.items.length} agents
            </text>
            <text fg={theme.textMuted}>
              Memory {status().memory.policy} · {status().memory.records} records
              {!status().memory.availability.available
                ? ` · ${status().memory.availability.reason?.replaceAll("_", " ") ?? "unavailable"}`
                : ""}
            </text>
          </box>
        )}
      </Show>
      <Show when={(capability()?.mcp.length ?? 0) > 0} fallback={<text fg={theme.text}>No MCP Servers</text>}>
        <box>
          <text fg={theme.text}>{capability()?.mcp.length ?? 0} MCP Servers</text>
          <For each={capability()?.mcp ?? []}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={item.status === "connected" ? theme.success : theme.warning}>
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.name}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>
                    {item.status === "connected" ? "Connected" : item.reason?.replaceAll("_", " ")}
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      {sync.data.lsp.length > 0 && (
        <box>
          <text fg={theme.text}>{sync.data.lsp.length} LSP Servers</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: theme.success,
                      error: theme.error,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.text}>No Formatters</text>}>
        <box>
          <text fg={theme.text}>{enabledFormatters().length} Formatters</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={pluginCount() > 0} fallback={<text fg={theme.text}>No Plugins</text>}>
        <text fg={theme.text}>{pluginCount()} Plugins loaded</text>
      </Show>
    </box>
  )
}
