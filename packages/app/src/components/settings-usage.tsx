import { Button } from "@newhorse/ui/button"
import { Spinner } from "@newhorse/ui/spinner"
import { For, Show, createResource, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"

type SessionUsage = {
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  model?: { id: string; providerID: string }
}

type StatRow = {
  name: string
  sessions: number
  tokens: number
  cost: number
  avgCost: number
}

type UsageTotals = {
  sessions: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  byModel: StatRow[]
  byProvider: StatRow[]
}

function aggregate(sessions: SessionUsage[]): UsageTotals {
  const total: UsageTotals = {
    sessions: 0,
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    byModel: [],
    byProvider: [],
  }

  const byModel = new Map<string, StatRow>()
  const byProvider = new Map<string, StatRow>()
  const modelProvider = new Map<string, string>()

  for (const session of sessions) {
    const cost = typeof session.cost === "number" ? session.cost : 0
    const tokens = session.tokens
    total.cost += cost
    if (tokens) {
      total.input += tokens.input
      total.output += tokens.output
      total.reasoning += tokens.reasoning
      total.cacheRead += tokens.cache.read
      total.cacheWrite += tokens.cache.write
    }

    const model = session.model?.id ?? "unknown"
    const provider = session.model?.providerID ?? "unknown"
    modelProvider.set(model, provider)
    const tokenCount = (tokens?.input ?? 0) + (tokens?.output ?? 0)

    const row = byModel.get(model) ?? { name: model, sessions: 0, tokens: 0, cost: 0, avgCost: 0 }
    row.sessions += 1
    row.tokens += tokenCount
    row.cost += cost
    byModel.set(model, row)

    const pRow = byProvider.get(provider) ?? { name: provider, sessions: 0, tokens: 0, cost: 0, avgCost: 0 }
    pRow.sessions += 1
    pRow.tokens += tokenCount
    pRow.cost += cost
    byProvider.set(provider, pRow)
  }

  total.sessions = sessions.length
  for (const row of byModel.values()) row.avgCost = row.sessions > 0 ? row.cost / row.sessions : 0
  for (const row of byProvider.values()) row.avgCost = row.sessions > 0 ? row.cost / row.sessions : 0
  total.byModel = [...byModel.values()].sort((a, b) => b.cost - a.cost)
  total.byProvider = [...byProvider.values()].sort((a, b) => b.cost - a.cost)

  return total
}

export function SettingsUsage() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [usage, { refetch }] = createResource(async () => {
    // Fetch a generous page so the totals aren't silently cut off at the
    // server's default list limit.
    const res = await serverSDK().client.session.list({ limit: 1000 })
    return aggregate((res.data ?? []) as SessionUsage[])
  })

  const format = (value: number) => value.toLocaleString(language.intl())
  // Standard cache hit rate: cached input tokens / total input tokens.
  const cacheHitRate = () => {
    const total = usage()
    if (!total || total.sessions === 0) return undefined
    if (total.input <= 0) return undefined
    return total.cacheRead / total.input
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-6 py-8">
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.usage.title")}</h2>
            <p class="text-12-regular text-text-weak">{language.t("settings.usage.description")}</p>
          </div>
          <Button size="small" disabled={usage.loading} onClick={() => void refetch()}>
            {usage.loading ? <Spinner class="size-3.5" /> : language.t("common.refresh")}
          </Button>
        </div>

        <Show when={!usage.loading} fallback={<div>{language.t("settings.usage.loading")}</div>}>
          <Show
            when={!usage.error}
            fallback={
              <div class="flex items-center gap-3 text-14-regular text-text-weak">
                <span>{language.t("settings.usage.unavailable")}</span>
                <Button size="small" onClick={() => void refetch()}>
                  {language.t("common.retry")}
                </Button>
              </div>
            }
          >
            <Show
              when={(usage()?.sessions ?? 0) > 0}
              fallback={<div class="text-14-regular text-text-weak">{language.t("settings.usage.empty")}</div>}
            >
              <div class="flex flex-col gap-6">
                <UsageSection title={language.t("settings.usage.section.overview")}>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Stat label={language.t("settings.usage.sessions")} value={format(usage()!.sessions)} />
                    <Stat
                      label={language.t("settings.usage.cost")}
                      value={usage()!.cost > 0 ? `$${usage()!.cost.toFixed(2)}` : "$0.00"}
                    />
                  </div>
                </UsageSection>

                <UsageSection title={language.t("settings.usage.section.tokens")}>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Stat label={language.t("settings.usage.inputTokens")} value={format(usage()!.input)} />
                    <Stat label={language.t("settings.usage.outputTokens")} value={format(usage()!.output)} />
                    <Stat label={language.t("settings.usage.reasoningTokens")} value={format(usage()!.reasoning)} />
                  </div>
                </UsageSection>

                <UsageSection title={language.t("settings.usage.section.cache")}>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Stat label={language.t("settings.usage.cacheRead")} value={format(usage()!.cacheRead)} />
                    <Stat label={language.t("settings.usage.cacheWrite")} value={format(usage()!.cacheWrite)} />
                    <Stat
                      label={language.t("settings.usage.cacheHitRate")}
                      value={
                        cacheHitRate() === undefined
                          ? language.t("settings.usage.na")
                          : `${format(usage()!.cacheRead)} / ${format(usage()!.input)} · ${(cacheHitRate()! * 100).toFixed(1)}%`
                      }
                    />
                  </div>
                </UsageSection>

                <Show when={usage()!.byModel.length > 0}>
                  <UsageSection title={language.t("settings.usage.section.byModel")}>
                    <UsageTable
                      headers={[
                        language.t("settings.usage.table.model"),
                        language.t("settings.usage.table.sessions"),
                        language.t("settings.usage.table.tokens"),
                        language.t("settings.usage.table.cost"),
                        language.t("settings.usage.table.avgCost"),
                      ]}
                      rows={usage()!.byModel}
                      format={format}
                      formatCost={(value) => `$${value.toFixed(2)}`}
                    />
                  </UsageSection>
                </Show>

                <Show when={usage()!.byProvider.length > 0}>
                  <UsageSection title={language.t("settings.usage.section.byProvider")}>
                    <UsageTable
                      headers={[
                        language.t("settings.usage.table.provider"),
                        language.t("settings.usage.table.sessions"),
                        language.t("settings.usage.table.tokens"),
                        language.t("settings.usage.table.cost"),
                        language.t("settings.usage.table.avgCost"),
                      ]}
                      rows={usage()!.byProvider}
                      format={format}
                      formatCost={(value) => `$${value.toFixed(2)}`}
                    />
                  </UsageSection>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function UsageSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-3">
      <h3 class="text-13-regular text-text-weak">{props.title}</h3>
      {props.children}
    </section>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-base px-4 py-3">
      <span class="text-13-regular text-text-weak">{props.label}</span>
      <span class="text-14-semibold text-text-strong">{props.value}</span>
    </div>
  )
}

function UsageTable(props: {
  headers: string[]
  rows: StatRow[]
  format: (value: number) => string
  formatCost: (value: number) => string
}) {
  return (
    <div class="overflow-x-auto rounded-lg bg-surface-base">
      <table class="w-full text-left">
        <thead>
          <tr class="border-b border-border-weak-base text-11-regular text-text-weak">
            <For each={props.headers}>
              {(header) => (
                <th class="px-4 py-2 font-normal" classList={{ "text-right": header !== props.headers[0] }}>
                  {header}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr class="border-b border-border-weak-base last:border-none text-13-regular text-text-base">
                <td class="px-4 py-2.5 text-text-strong">{row.name}</td>
                <td class="px-4 py-2.5 text-right">{props.format(row.sessions)}</td>
                <td class="px-4 py-2.5 text-right">{props.format(row.tokens)}</td>
                <td class="px-4 py-2.5 text-right">{props.formatCost(row.cost)}</td>
                <td class="px-4 py-2.5 text-right">{props.formatCost(row.avgCost)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}
