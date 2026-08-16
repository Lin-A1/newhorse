import { createSignal, Show } from "solid-js"
import { Icon as IconV2 } from "@newhorse/ui/v2/icon"
import { Markdown } from "@newhorse/session-ui/markdown"
import { useLanguage } from "@/context/language"

/**
 * Single-line compaction marker (deepseek-harness CompactionItem pattern).
 * The checkpoint payload (the model-generated summary) is the expandable
 * disclosure, never rendered as normal assistant output. The compacted
 * conversation stays above the marker, scrollable as usual.
 */
export function CompactionMarker(props: {
  summary?: string
  messageCount: number
  tokenCount?: number
}) {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(false)
  const expandable = !!props.summary && props.summary.trim().length > 0

  const countLabel = () => {
    const parts: string[] = []
    if (props.messageCount > 0)
      parts.push(language.t("timeline.compaction.messages", { count: String(props.messageCount) }))
    if (props.tokenCount)
      parts.push(language.t("timeline.compaction.tokens", { count: String(props.tokenCount) }))
    return parts.join(" · ")
  }

  return (
    <div class="flex flex-col overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-layer-01">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? expanded() : undefined}
        onClick={() => setExpanded((value) => !value)}
        class="flex h-8 items-center gap-2 px-3 text-left text-[12px]"
      >
        <IconV2 name="checklist" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        <span class="min-w-0 flex-1 truncate font-medium text-v2-text-text-muted">
          {language.t("ui.messagePart.compaction")}
        </span>
        <Show when={expandable}>
          <IconV2
            name="collapse"
            size="small"
            class={`shrink-0 text-v2-icon-icon-muted transition-transform duration-150 ${
              expanded() ? "" : "rotate-180"
            }`}
          />
        </Show>
        <Show when={countLabel()}>
          <span class="shrink-0 text-[11px] text-v2-text-text-faint">{countLabel()}</span>
        </Show>
      </button>
      <Show when={expandable && expanded()}>
        <div class="max-h-72 overflow-y-auto border-t border-v2-border-border-muted px-3 py-2">
          <Markdown text={props.summary!} />
        </div>
      </Show>
    </div>
  )
}
