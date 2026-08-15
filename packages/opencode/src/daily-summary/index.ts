import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { DailySummaryTable } from "@newhorse/core/daily-summary/sql"
import { and, desc, eq, gte, lt } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import * as Stream from "effect/Stream"
import { FSUtil } from "@newhorse/core/fs-util"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { Profile } from "@/profile"
import { MessageID, SessionID } from "@/session/schema"
import { SessionV1 } from "@newhorse/core/v1/session"
import { LLMEvent } from "@newhorse/llm"
import { dayEndMs, dayStartMs, readClaudeCode, readCodex, readNewhorse, type DailyEntry } from "./readers"

/** Local date key YYYY-MM-DD. */
function localDateKey(ts: number) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function sourceLabel(source: DailyEntry["source"]) {
  return source === "work" ? "work" : source === "companion" ? "newhorse" : source === "claude" ? "Claude Code" : "Codex"
}

function fallbackSummary(entries: DailyEntry[]) {
  const groups = entries.map((e) => `[${sourceLabel(e.source)}] ${e.title}: ${e.snippet}`).join("\n")
  return `今天在本机 AI 工具中共有 ${entries.length} 条会话：\n${groups}`
}

export const Info = Schema.Struct({
  date: Schema.String,
  content: Schema.String,
  timeCreated: Schema.Number,
})
export type Info = Schema.Schema.Type<typeof Info>

export interface Interface {
  /** Generate (or regenerate) the summary for a date, persisting it. Returns the text, or undefined when no sessions that day. */
  readonly generate: (input?: { date?: number }) => Effect.Effect<string | undefined>
  /** Draft a fresh summary for a date WITHOUT persisting it. Returns the text, or undefined when no sessions that day. */
  readonly draft: (input?: { date?: number }) => Effect.Effect<string | undefined>
  /** Fetch the stored summary for the local date of a ms timestamp, if any. */
  readonly get: (input: { date: number }) => Effect.Effect<Info | undefined>
  /** List summaries between from/to (inclusive, ms timestamps). */
  readonly list: (input?: { from?: number; to?: number }) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/DailySummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const session = yield* Session.Service
    const agent = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const profile = yield* Profile.Service

    const generateText = Effect.fn("DailySummary.generateText")(function* (entries: DailyEntry[], dateKey: string) {
      const ag = yield* agent.get("summary")
      const def = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!ag || !def) return fallbackSummary(entries)
      const smallModel = yield* provider.getSmallModel(def.providerID).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!smallModel) return fallbackSummary(entries)

      const user = {
        id: MessageID.make("daily-summary"),
        type: "user",
        role: "user",
        time: { created: Date.now() },
        sessionID: SessionID.make("daily-summary"),
        text: "",
      } as unknown as SessionV1.User

      const body = entries.map((e) => `[${sourceLabel(e.source)}] ${e.title}: ${e.snippet}`).join("\n")
      const text = yield* llm
        .stream({
          agent: ag,
          user,
          system: [],
          small: true,
          tools: {},
          model: smallModel,
          sessionID: "daily-summary",
          retries: 2,
          messages: [
            {
              role: "user",
              content:
                `这是 ${dateKey} 你在本机各 AI 工具（newhorse work、newhorse、Claude Code、Codex）中的会话片段。` +
                `请用简洁、自然的中文总结今天做了什么、进展和结论，控制在 200 字以内：\n\n${body}`,
            },
          ],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
      return cleaned || fallbackSummary(entries)
    })

    const draft = Effect.fn("DailySummary.draft")(function* (input?: { date?: number }) {
      const date = new Date(input?.date ?? Date.now())
      const start = dayStartMs(date)
      const end = dayEndMs(date)
      const [claude, codex, newhorse] = yield* Effect.all([
        readClaudeCode(fs, start, end),
        readCodex(fs, date, start, end),
        readNewhorse(session, start, end),
      ])
      const entries: DailyEntry[] = [
        ...newhorse,
        ...claude.map((snippet) => ({ source: "claude" as const, title: "Claude Code", snippet })),
        ...codex.map((snippet) => ({ source: "codex" as const, title: "Codex", snippet })),
      ]
      if (entries.length === 0) return undefined
      const dateKey = localDateKey(start)
      return yield* generateText(entries, dateKey)
    })

    const persist = Effect.fn("DailySummary.persist")(function* (input: { date: number; content: string }) {
      const dateKey = localDateKey(dayStartMs(new Date(input.date)))
      yield* db
        .insert(DailySummaryTable)
        .values({ date: dateKey, content: input.content })
        .onConflictDoUpdate({
          target: DailySummaryTable.date,
          set: { content: input.content, time_updated: Date.now() },
        })
        .pipe(Effect.orDie)
    })

    const generate = Effect.fn("DailySummary.generate")(function* (input?: { date?: number }) {
      const content = yield* draft(input)
      if (!content) return undefined
      yield* persist({ date: input?.date ?? Date.now(), content })
      return content
    })

    const get = Effect.fn("DailySummary.get")(function* (input: { date: number }) {
      const key = localDateKey(dayStartMs(new Date(input.date)))
      const row = yield* db
        .select()
        .from(DailySummaryTable)
        .where(eq(DailySummaryTable.date, key))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return { date: row.date, content: row.content, timeCreated: row.time_created }
    })

    const list = Effect.fn("DailySummary.list")(function* (input?: { from?: number; to?: number }) {
      const rows = yield* db
        .select()
        .from(DailySummaryTable)
        .where(
          and(
            input?.from !== undefined ? gte(DailySummaryTable.time_created, input.from) : undefined,
            input?.to !== undefined ? lt(DailySummaryTable.time_created, input.to) : undefined,
          ),
        )
        .orderBy(desc(DailySummaryTable.date))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ date: row.date, content: row.content, timeCreated: row.time_created }))
    })

    // Every minute: once past 23:00 local, generate today's summary if missing;
    // if today is already summarized but yesterday was missed (e.g. the app
    // wasn't running in yesterday's 23:00 window), backfill one day.
    const maybeGenerateToday = Effect.fn("DailySummary.maybeGenerateToday")(function* () {
      const now = Date.now()
      const start = dayStartMs(new Date(now))
      if (now < start + 23 * 3_600_000) return
      const runtime = yield* profile
        .runtime(Profile.ID.make("companion"))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!runtime?.dailySummary) return

      const hasSummary = (ts: number) =>
        db
          .select({ date: DailySummaryTable.date })
          .from(DailySummaryTable)
          .where(eq(DailySummaryTable.date, localDateKey(dayStartMs(new Date(ts)))))
          .get()
          .pipe(Effect.map((row) => row !== undefined), Effect.orDie)

      const ensure = (ts: number) =>
        generate({ date: ts }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("daily summary generation failed", { cause })),
        )

      if (!(yield* hasSummary(start))) {
        yield* ensure(start)
      } else if (!(yield* hasSummary(start - 86_400_000))) {
        // Today is done but yesterday was missed; backfill exactly one day.
        yield* ensure(start - 86_400_000)
      }
    })

    yield* maybeGenerateToday().pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({ generate, draft, get, list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node, FSUtil.node, Session.node, Agent.node, Provider.node, LLM.node, Profile.node],
})

export * as DailySummary from "./index"
