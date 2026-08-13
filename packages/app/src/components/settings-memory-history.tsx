import type { MemoryHistoryInfo, MemoryInfo } from "@newhorse/sdk/v2"
import { Spinner } from "@newhorse/ui/spinner"
import { Button } from "@newhorse/ui/button"
import { For, Show, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function MemoryHistoryPanel(props: {
  item: MemoryInfo
  load: (item: MemoryInfo) => Promise<MemoryHistoryInfo[]>
}) {
  const language = useLanguage()
  const [attempt, setAttempt] = createSignal(0)
  const [history] = createResource(
    () => `${props.item.id}:${attempt()}`,
    () => props.load(props.item),
  )

  return (
    <Show
      when={history()}
      fallback={<MemoryHistoryFallback error={history.error()} onRetry={() => setAttempt((count) => count + 1)} />}
    >
      {(entries) => (
        <Show
          when={entries().length > 0}
          fallback={<p class="text-12-regular text-text-weak">{language.t("settings.memory.audit.empty")}</p>}
        >
          <ol class="flex flex-col gap-3 border-t border-border-weak-base pt-3">
            <For each={entries()}>{(entry) => <MemoryHistoryEntry entry={entry} />}</For>
          </ol>
        </Show>
      )}
    </Show>
  )
}

function MemoryHistoryFallback(props: { error: unknown; onRetry: () => void }) {
  const language = useLanguage()
  return (
    <Show
      when={!props.error}
      fallback={
        <div class="flex items-center gap-3 text-12-regular text-text-weak">
          <span>{language.t("common.requestFailed")}</span>
          <Button size="small" onClick={props.onRetry}>
            {language.t("common.retry")}
          </Button>
        </div>
      }
    >
      <div
        role="status"
        aria-live="polite"
        data-state="loading"
        class="flex items-center gap-2 text-12-regular text-text-weak"
      >
        <Spinner class="size-3.5 shrink-0" />
        {language.t("settings.memory.loading")}
      </div>
    </Show>
  )
}

function MemoryHistoryEntry(props: { entry: MemoryHistoryInfo }) {
  const language = useLanguage()
  return (
    <li class="flex flex-col gap-1" data-memory-history-event={props.entry.event}>
      <div class="flex items-baseline justify-between gap-2 text-11-regular">
        <span class="text-text-strong">{language.t(`settings.memory.audit.event.${props.entry.event}`)}</span>
        <time class="text-text-weaker" datetime={new Date(props.entry.createdAt).toISOString()}>
          {new Date(props.entry.createdAt).toLocaleString()}
        </time>
      </div>
      <Show when={props.entry.oldContent !== undefined || props.entry.newContent !== undefined}>
        <div class="flex flex-col gap-1 text-12-regular text-text-base">
          <Show when={props.entry.oldContent !== undefined}>
            <p class="whitespace-pre-wrap">
              <span class="text-text-weaker">{language.t("settings.memory.audit.old")}: </span>
              {props.entry.oldContent}
            </p>
          </Show>
          <Show when={props.entry.newContent !== undefined}>
            <p class="whitespace-pre-wrap">
              <span class="text-text-weaker">{language.t("settings.memory.audit.new")}: </span>
              {props.entry.newContent}
            </p>
          </Show>
        </div>
      </Show>
      <Show when={props.entry.actorID}>
        {(actorID) => (
          <p class="text-11-regular text-text-weaker">
            {language.t("settings.memory.audit.actor", { id: actorID() })}
          </p>
        )}
      </Show>
    </li>
  )
}
