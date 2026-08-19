import { Button } from "@newhorse/ui/button"
import { Spinner } from "@newhorse/ui/spinner"
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"

type SessionUsage = {
  id?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  model?: { id: string; providerID: string }
  time?: { created: number }
  location?: { directory: string }
}

// Per-message breakdown for a single session. Each row is one assistant turn
// (already split across tool steps inside the processor), so adding rows
// together gives the session's true cost/tokens split by model.
export type MessageUsage = {
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  providerID: string
  modelID: string
  time: number
}

export type SessionUsageWithMessages = SessionUsage & {
  id: string
  messages: MessageUsage[]
}

type RangeKey = "today" | "7d" | "30d" | "all"

type StatRow = {
  name: string
  sessions: number
  tokens: number
  cost: number
  avgCost: number
}

type TrendPoint = {
  label: string
  cost: number
  tokens: number
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
  trend: TrendPoint[]
}

/** @internal Exported for unit tests. */
export function rangeStart(range: RangeKey, now: number): number | undefined {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const start = startOfToday.getTime()
  if (range === "today") return start
  if (range === "7d") return start - 6 * 24 * 60 * 60 * 1000
  if (range === "30d") return start - 29 * 24 * 60 * 60 * 1000
  return undefined
}

function dayLabel(ts: number) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** @internal Exported for unit tests. */
export function aggregate(sessions: SessionUsageWithMessages[], range: RangeKey, now: number): UsageTotals {
  const start = rangeStart(range, now)
  const filtered = start === undefined ? sessions : sessions.filter((s) => (s.time?.created ?? now) >= start)

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
    trend: [],
  }

  const byModel = new Map<string, StatRow>()
  const byProvider = new Map<string, StatRow>()
  const byDay = new Map<string, TrendPoint>()

  for (const session of filtered) {
    const sessionStart = session.time?.created ?? now
    total.sessions += 1

    const messages = session.messages
    if (messages && messages.length > 0) {
      // Split by message-level model so a session that switched models is
      // counted under each model it actually used, not the current one.
      const sessionByModel = new Map<string, MessageUsage>()
      for (const message of messages) {
        if (start !== undefined && message.time < start) continue

        const cost = typeof message.cost === "number" ? message.cost : 0
        const tokens = message.tokens
        total.cost += cost
        if (tokens) {
          total.input += tokens.input
          total.output += tokens.output
          total.reasoning += tokens.reasoning
          total.cacheRead += tokens.cache.read
          total.cacheWrite += tokens.cache.write
        }

        const key = `${message.providerID}/${message.modelID}`
        const merged = sessionByModel.get(key) ?? {
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          providerID: message.providerID,
          modelID: message.modelID,
          time: message.time,
        }
        merged.cost += cost
        merged.tokens.input += tokens?.input ?? 0
        merged.tokens.output += tokens?.output ?? 0
        merged.tokens.reasoning += tokens?.reasoning ?? 0
        merged.tokens.cache.read += tokens?.cache?.read ?? 0
        merged.tokens.cache.write += tokens?.cache?.write ?? 0
        merged.time = Math.max(merged.time, message.time)
        sessionByModel.set(key, merged)

        const label = dayLabel(message.time)
        const day = byDay.get(label) ?? { label, cost: 0, tokens: 0 }
        day.cost += cost
        day.tokens += (tokens?.input ?? 0) + (tokens?.output ?? 0)
        byDay.set(label, day)
      }

      for (const message of sessionByModel.values()) {
        // Match the overview's token figure (input + output + reasoning) so the
        // per-model table doesn't look like it's missing a big chunk of usage.
        const tokenCount =
          message.tokens.input + message.tokens.output + message.tokens.reasoning
        const row = byModel.get(message.modelID) ?? {
          name: message.modelID,
          sessions: 0,
          tokens: 0,
          cost: 0,
          avgCost: 0,
        }
        row.sessions += 1
        row.tokens += tokenCount
        row.cost += message.cost
        byModel.set(message.modelID, row)

        const pRow = byProvider.get(message.providerID) ?? {
          name: message.providerID,
          sessions: 0,
          tokens: 0,
          cost: 0,
          avgCost: 0,
        }
        pRow.sessions += 1
        pRow.tokens += tokenCount
        pRow.cost += message.cost
        byProvider.set(message.providerID, pRow)
      }
      continue
    }

    // Fallback when per-message breakdown is unavailable (deleted sessions
    // come from session.usage, which only exposes totals). Keep the old
    // whole-session accounting so the totals stay consistent.
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
    const tokenCount = (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)

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

    const label = dayLabel(sessionStart)
    const day = byDay.get(label) ?? { label, cost: 0, tokens: 0 }
    day.cost += cost
    day.tokens += tokenCount
    byDay.set(label, day)
  }

  // Sessions count uses the filtered list (one row per real session). When
  // messages are loaded, drop sessions that had no in-range messages so the
  // number reflects sessions actually active in the window.
  if (sessions.some((s) => s.messages.length > 0)) {
    total.sessions = filtered.filter(
      (s) =>
        s.messages.length === 0 ||
        s.messages.some((m) => (start === undefined ? true : m.time >= start)),
    ).length
  }
  for (const row of byModel.values()) row.avgCost = row.sessions > 0 ? row.cost / row.sessions : 0
  for (const row of byProvider.values()) row.avgCost = row.sessions > 0 ? row.cost / row.sessions : 0
  total.byModel = [...byModel.values()].sort((a, b) => b.cost - a.cost)
  total.byProvider = [...byProvider.values()].sort((a, b) => b.cost - a.cost)

  // Trend: last 30 days, ascending by date. Uses calendar days when range spans
  // days; for "today" just the single bucket.
  const days = range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 30
  const bucketStart = rangeStart(range === "all" ? "30d" : range, now) ?? now
  const buckets: TrendPoint[] = []
  for (let i = 0; i < days; i++) {
    const ts = bucketStart + i * 24 * 60 * 60 * 1000
    const label = dayLabel(ts)
    buckets.push(byDay.get(label) ?? { label, cost: 0, tokens: 0 })
  }
  total.trend = buckets

  return total
}

const RANGES: RangeKey[] = ["today", "7d", "30d", "all"]

const SESSION_LIST_PAGE_SIZE = 1000
const MAX_SESSION_LIST_PAGES = 100

// session.list is capped per request; follow the x-next-cursor header to fetch
// every page so usage beyond the first page of sessions is not silently dropped
// from the stats. Archived sessions are included (archived is not deleted; their
// usage stays in the session row, so skipping them would drop whole sessions).
/** @internal Exported for unit tests. */
export async function listAllSessions(serverSDK: () => ServerSDK): Promise<SessionUsage[]> {
  const sessions: SessionUsage[] = []
  let cursor: number | undefined
  for (let page = 0; page < MAX_SESSION_LIST_PAGES; page++) {
    const res = await serverSDK()
      .client.experimental.session.list({
        limit: SESSION_LIST_PAGE_SIZE,
        archived: true,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      .catch((error) => {
        // The listing route itself is unavailable (older server, missing
        // endpoint). Fail the first page so callers surface a real error
        // instead of rendering an empty-looking heatmap/stats grid. Later-page
        // failures are transient and degrade to whatever was already fetched.
        if (page === 0) throw error
        return undefined
      })
    if (!res) break
    const pageSessions = (res.data ?? []) as SessionUsage[]
    sessions.push(...pageSessions)
    const next = res.response?.headers.get("x-next-cursor")
    if (!next || pageSessions.length === 0) break
    cursor = Number(next)
  }
  return sessions
}

const MESSAGES_PAGE_SIZE = 200
const MAX_MESSAGES_PAGES = 50

// Pulls every assistant message in a session. Used to break down cost/tokens
// by message-level model so a session that switched models mid-flight is
// counted under each model it actually used.
async function fetchSessionMessages(
  serverSDK: () => ServerSDK,
  sessionID: string,
  directory: string,
): Promise<MessageUsage[]> {
  const out: MessageUsage[] = []
  const client = serverSDK().createClient({ directory, throwOnError: true })
  let before: string | undefined
  for (let page = 0; page < MAX_MESSAGES_PAGES; page++) {
    const res = await client.session
      .messages({
        sessionID,
        limit: MESSAGES_PAGE_SIZE,
        ...(before !== undefined ? { before } : {}),
      })
      .catch(() => undefined)
    if (!res) break
    const items = (res.data ?? []) as Array<{
      info: {
        role?: string
        cost?: unknown
        tokens?: MessageUsage["tokens"]
        providerID?: unknown
        modelID?: unknown
        time?: { created?: unknown }
      }
    }>
    for (const item of items) {
      const info = item.info
      if (!info || info.role !== "assistant") continue
      const tokens = info.tokens
      const created = info.time?.created
      out.push({
        cost: typeof info.cost === "number" ? info.cost : 0,
        tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        providerID: typeof info.providerID === "string" ? info.providerID : "unknown",
        modelID: typeof info.modelID === "string" ? info.modelID : "unknown",
        time: typeof created === "number" ? created : Date.now(),
      })
    }
    const next = res.response?.headers.get("x-next-cursor")
    if (!next || items.length === 0) break
    before = next
  }
  return out
}

const MESSAGE_FETCH_CONCURRENCY = 8
// Only fetch per-message breakdowns for sessions created in the last 90 days.
// Older sessions' message history is large and rarely viewed; their row-level
// accumulated totals are still folded in by aggregate() via the fallback path,
// and skipping them keeps the usage tab's poll cheap enough to actually refresh.
const MESSAGE_BREAKDOWN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

// Loads per-message breakdown for the listed sessions with bounded concurrency.
// Failures (older servers, deleted sessions, network blips) degrade to empty
// arrays so the totals still reflect the session row's accumulated cost.
async function loadMessageBreakdown(
  serverSDK: () => ServerSDK,
  sessions: SessionUsage[],
): Promise<Map<string, MessageUsage[]>> {
  const result = new Map<string, MessageUsage[]>()
  const cutoff = Date.now() - MESSAGE_BREAKDOWN_MAX_AGE_MS
  const targets = sessions.filter((s) => {
    const created = s.time?.created
    if (!created) return false
    if (created < cutoff) return false
    return Boolean(s.id && s.location?.directory)
  })
  // Sessions we won't fetch messages for still need an (empty) entry so the
  // caller's mapping doesn't crash — aggregate falls back to row totals.
  for (const session of sessions) {
    if (!result.has(session.id ?? "")) result.set(session.id ?? "", [])
  }
  let cursor = 0
  const workers = Array.from({ length: MESSAGE_FETCH_CONCURRENCY }, async () => {
    while (true) {
      const index = cursor++
      if (index >= targets.length) return
      const session = targets[index]
      if (!session) continue
      try {
        const messages = await fetchSessionMessages(serverSDK, session.id!, session.location!.directory)
        result.set(session.id!, messages)
      } catch {
        result.set(session.id!, [])
      }
    }
  })
  await Promise.all(workers)
  return result
}

export function SettingsUsage() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [range, setRange] = createSignal<RangeKey>("7d")

  const [raw, { refetch }] = createResource(async () => {
    // Use the global session list so the usage stats cover ALL projects, not
    // just the current one — otherwise a session created in another project
    // makes today's usage look empty.
    const [sessions, archivedRes] = await Promise.all([
      listAllSessions(serverSDK),
      // Archived usage of deleted sessions. Graceful when the server is older
      // or slow: race it with a short timeout so the usage tab never hangs.
      Promise.race([
        serverSDK()
          .client.session.usage()
          .then((res) => (res.data ?? []) as SessionUsage[]),
        new Promise<SessionUsage[]>((resolve) => setTimeout(() => resolve([]), 3000)),
      ]).catch(() => [] as SessionUsage[]),
    ])
    // Active + archived sessions, plus usage of deleted sessions, so clearing a
    // session does not erase its token/cost contribution from the stats.
    const combined: SessionUsage[] = [...sessions, ...archivedRes]
    // Per-message breakdown for sessions that still exist on the server.
    // archivedRes rows lack an id/directory, so skip them — the row totals
    // are still folded in below.
    const messagesBySession = await loadMessageBreakdown(serverSDK, sessions)
    const enriched: SessionUsageWithMessages[] = combined.map((session) => ({
      ...session,
      id: session.id ?? "",
      messages: messagesBySession.get(session.id ?? "") ?? [],
    }))
    return enriched
  })

  // The stats are only as fresh as the last fetch, so keep them current while
  // the tab is mounted: a 10s poll plus a refetch when the tab regains focus.
  // A dedicated inFlight flag (not raw.loading — which stays true during the
  // whole initial load AND every refetch) prevents stacking fetches without
  // accidentally skipping polls that Solid marks as still "loading".
  let inFlight = false
  const refresh = () => {
    if (inFlight) return
    inFlight = true
    void Promise.resolve(refetch()).finally(() => {
      inFlight = false
    })
  }
  onMount(() => {
    const timer = setInterval(refresh, 10_000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh()
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisibility)
    })
  })

  const usage = createMemo(() => {
    const sessions = raw()
    if (!sessions) return undefined
    return aggregate(sessions, range(), Date.now())
  })

  const format = (value: number) => value.toLocaleString(language.intl())
  // Cache hit rate uses the full billed input footprint as the denominator so
  // it can never exceed 100%: read / (read + write + input).
  const cacheHitRate = () => {
    const total = usage()
    if (!total || total.sessions === 0) return undefined
    const totalInput = total.cacheRead + total.cacheWrite + total.input
    if (totalInput <= 0) return undefined
    return total.cacheRead / totalInput
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-6 py-8">
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.usage.title")}</h2>
            <p class="text-12-regular text-text-weak">{language.t("settings.usage.description")}</p>
          </div>
          <div class="flex items-center gap-2">
            <div class="flex rounded-md bg-surface-subtle p-0.5" role="radiogroup" aria-label={language.t("settings.usage.range")}>
              <For each={RANGES}>
                {(key) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={range() === key}
                    class={`rounded px-2 py-1 text-12-regular transition-colors ${
                      range() === key ? "bg-surface-raised-base text-text-strong shadow-sm" : "text-text-weak hover:text-text-base"
                    }`}
                    onClick={() => setRange(key)}
                  >
                    {language.t(`settings.usage.range.${key}`)}
                  </button>
                )}
              </For>
            </div>
            <Button size="small" disabled={raw.loading} onClick={() => void refetch()}>
              {raw.loading ? <Spinner class="size-3.5" /> : language.t("common.refresh")}
            </Button>
          </div>
        </div>

        {/* Only swap to the loading spinner when there is nothing to show yet.
            A refetch (the 5s poll, focus, or the refresh button) keeps the
            previous stats rendered via raw() while loading is true. */}
        <Show when={!raw.loading || raw() !== undefined} fallback={<div>{language.t("settings.usage.loading")}</div>}>
          <Show
            when={!raw.error}
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
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Stat label={language.t("settings.usage.sessions")} value={format(usage()!.sessions)} />
                    <Stat
                      label={language.t("settings.usage.cost")}
                      value={usage()!.cost > 0 ? `$${usage()!.cost.toFixed(2)}` : "$0.00"}
                    />
                    <Stat
                      label={language.t("settings.usage.cacheHitRate")}
                      value={
                        cacheHitRate() === undefined
                          ? language.t("settings.usage.na")
                          : `${(cacheHitRate()! * 100).toFixed(1)}%`
                      }
                    />
                  </div>
                </UsageSection>

                <UsageSection title={language.t("settings.usage.section.trend")}>
                  <TrendChart points={usage()!.trend} formatValue={(v) => `$${v.toFixed(2)}`} />
                </UsageSection>

                <UsageSection title={language.t("settings.usage.section.tokens")}>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Stat label={language.t("settings.usage.inputTokens")} value={format(usage()!.input)} />
                    <Stat label={language.t("settings.usage.outputTokens")} value={format(usage()!.output)} />
                    <Stat label={language.t("settings.usage.reasoningTokens")} value={format(usage()!.reasoning)} />
                  </div>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Stat label={language.t("settings.usage.cacheRead")} value={format(usage()!.cacheRead)} />
                    <Stat label={language.t("settings.usage.cacheWrite")} value={format(usage()!.cacheWrite)} />
                    <Stat label={language.t("settings.usage.cacheHitRateDetail")} value={cacheHitRateDetail()} />
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

  function cacheHitRateDetail() {
    const total = usage()
    const rate = cacheHitRate()
    if (!total || rate === undefined) return language.t("settings.usage.na")
    return `${format(total.cacheRead)} / ${format(total.cacheRead + total.cacheWrite + total.input)} · ${(rate * 100).toFixed(1)}%`
  }
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

function TrendChart(props: { points: { label: string; cost: number; tokens: number }[]; formatValue: (n: number) => string }) {
  const max = () => Math.max(...props.points.map((p) => p.cost), 0.01)
  const barWidth = () => 100 / props.points.length
  return (
    <div class="rounded-lg bg-surface-base p-4">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" class="h-28 w-full">
        <For each={props.points}>
          {(point, i) => {
            const h = (point.cost / max()) * 36
            return <rect x={i() * barWidth() + 0.5} y={40 - h} width={Math.max(barWidth() - 1, 0.3)} height={h} rx={0.3} fill="currentColor" class="text-icon-info-active" />
          }}
        </For>
      </svg>
      <div class="mt-2 flex justify-between text-10-regular text-text-weaker">
        <For each={props.points}>
          {(point, i) => (
            <span
              class="truncate"
              title={`${point.label} · ${props.formatValue(point.cost)}`}
              style={{ width: `${barWidth()}%` }}
            >
              {point.label}
            </span>
          )}
        </For>
      </div>
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
