import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { DailySummaryTable } from "@newhorse/core/daily-summary/sql"
import { SessionTable, TodoTable } from "@newhorse/core/session/sql"
import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import * as Stream from "effect/Stream"
import { FSUtil } from "@newhorse/core/fs-util"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Profile } from "@/profile"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { SessionV1 } from "@newhorse/core/v1/session"
import { LLMEvent } from "@newhorse/llm"
import { dayEndMs, dayStartMs, localDateKey, readClaudeCode, readCodex, type DailySource } from "./readers"

const OVERVIEW_MAX_CHARS = 300

export const TodoInfo = Schema.Struct({
  content: Schema.String,
  status: Schema.String,
  priority: Schema.String,
})
export type TodoInfo = Schema.Schema.Type<typeof TodoInfo>

export const SessionDetail = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  source: Schema.Literals(["work", "companion"]),
  directory: Schema.String,
  model: Schema.optional(Schema.String),
  filesChanged: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
  files: Schema.Array(Schema.String),
  todos: Schema.Array(TodoInfo),
})
export type SessionDetail = Schema.Schema.Type<typeof SessionDetail>

export const Section = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
})
export type Section = Schema.Schema.Type<typeof Section>

export const UsageRollup = Schema.Struct({
  cost: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.Number,
    cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
  }),
  sessions: Schema.Number,
  models: Schema.Array(Schema.String),
})
export type UsageRollup = Schema.Schema.Type<typeof UsageRollup>

export const Report = Schema.Struct({
  date: Schema.String,
  overview: Schema.String,
  work: Schema.Array(Section),
  sessions: Schema.Array(SessionDetail),
  usage: UsageRollup,
  generatedAt: Schema.Number,
}).annotate({ identifier: "DailyReport" })
export type Report = Schema.Schema.Type<typeof Report>

export interface Interface {
  /** Generate (or regenerate) the report for a date, persisting it. Undefined when no activity that day. */
  readonly generate: (input?: { date?: number }) => Effect.Effect<Report | undefined>
  /** Draft a fresh report for a date WITHOUT persisting it. */
  readonly draft: (input?: { date?: number }) => Effect.Effect<Report | undefined>
  /** Fetch the stored report for the local date of a ms timestamp, if any. */
  readonly get: (input: { date: number }) => Effect.Effect<Report | undefined>
  /** List reports between from/to (inclusive, ms timestamps). */
  readonly list: (input?: { from?: number; to?: number }) => Effect.Effect<Report[]>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/DailySummary") {}

type RawRow = typeof SessionTable.$inferSelect

/** Decode a stored content string into a Report, tolerating the old plain-text blob. */
function decodeReport(date: string, content: string, generatedAt: number): Report {
  try {
    const parsed = JSON.parse(content) as Report
    if (parsed && typeof parsed === "object" && typeof parsed.overview === "string") {
      return {
        date: parsed.date ?? date,
        overview: parsed.overview,
        work: Array.isArray(parsed.work) ? parsed.work : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        usage: parsed.usage ?? emptyUsage(),
        generatedAt: parsed.generatedAt ?? generatedAt,
      }
    }
  } catch {
    // fall through to legacy plain-text handling
  }
  return {
    date,
    overview: content,
    work: [],
    sessions: [],
    usage: emptyUsage(),
    generatedAt,
  }
}

function emptyUsage(): UsageRollup {
  return { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, sessions: 0, models: [] }
}

function modelLabel(model: RawRow["model"]): string | undefined {
  if (!model) return undefined
  return `${model.providerID}/${model.id}`
}

function sourceLabel(source: DailySource): string {
  return source === "work" ? "work" : source === "companion" ? "newhorse" : source === "claude" ? "Claude Code" : "Codex"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const agent = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const profile = yield* Profile.Service
    const instanceStore = yield* InstanceStore.Service

    // ---------------------------------------------------------------------
    // Deterministic aggregation (no LLM): sessions + todos + usage for a day.
    // ---------------------------------------------------------------------
    const aggregate = Effect.fn("DailySummary.aggregate")(function* (date: Date) {
      const start = dayStartMs(date)
      const end = dayEndMs(date)
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(
          and(
            gte(SessionTable.time_updated, start),
            lt(SessionTable.time_updated, end),
            isNull(SessionTable.parent_id),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      const ids = rows.map((row) => row.id)
      const todoRows =
        ids.length > 0
          ? yield* db
              .select()
              .from(TodoTable)
              .where(inArray(TodoTable.session_id, ids))
              .all()
              .pipe(Effect.orDie)
          : []

      const todosBySession = new Map<string, TodoInfo[]>()
      for (const todo of todoRows) {
        const list = todosBySession.get(todo.session_id) ?? []
        list.push({ content: todo.content, status: todo.status, priority: todo.priority })
        todosBySession.set(todo.session_id, list)
      }

      const sessions: SessionDetail[] = rows.map((row) => {
        const diffs = row.summary_diffs ?? []
        const files = diffs.flatMap((diff) => (diff.file ? [diff.file] : []))
        return {
          sessionID: row.id,
          title: row.title,
          source: row.profile_id === "companion" ? "companion" : "work",
          directory: row.directory,
          model: modelLabel(row.model),
          filesChanged: row.summary_files ?? diffs.length,
          additions: row.summary_additions ?? diffs.reduce((sum, diff) => sum + diff.additions, 0),
          deletions: row.summary_deletions ?? diffs.reduce((sum, diff) => sum + diff.deletions, 0),
          files,
          todos: todosBySession.get(row.id) ?? [],
        }
      })

      const work: Section[] = sessions
        .filter((s) => s.filesChanged > 0 || s.additions > 0 || s.deletions > 0)
        .map((s) => {
          const lines = s.files.map((file) => `- ${file}`).join("\n")
          const head = `**${s.title}** · +${s.additions} −${s.deletions} · ${s.filesChanged} 文件`
          return { title: s.title, body: lines ? `${head}\n${lines}` : head }
        })

      const cost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)
      const tokens = rows.reduce(
        (acc, row) => ({
          input: acc.input + row.tokens_input,
          output: acc.output + row.tokens_output,
          reasoning: acc.reasoning + row.tokens_reasoning,
          cache: {
            read: acc.cache.read + row.tokens_cache_read,
            write: acc.cache.write + row.tokens_cache_write,
          },
        }),
        { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      )
      const models = [...new Set(rows.flatMap((row) => (modelLabel(row.model) ? [modelLabel(row.model)!] : [])))]

      return {
        sessions,
        work,
        usage: { cost, tokens, sessions: rows.length, models } satisfies UsageRollup,
      }
    })

    // ---------------------------------------------------------------------
    // Overview (LLM): a compact digest of the aggregated activity + external
    // Claude Code / Codex user snippets, distilled into a short Chinese recap.
    // ---------------------------------------------------------------------
    const fallbackOverview = (digest: string) => `今天在本机 AI 工具中有以下活动：\n${digest}`

    const synthesize = Effect.fn("DailySummary.synthesize")(function* (digest: string, dateKey: string) {
      const ag = yield* agent.get("summary")
      const def = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!ag || !def) return fallbackOverview(digest)
      const smallModel = yield* provider.getSmallModel(def.providerID).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const model =
        smallModel ??
        (yield* provider.getModel(def.providerID, def.modelID).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ))
      if (!model) return fallbackOverview(digest)

      const user = {
        id: MessageID.make("msg-daily-summary"),
        type: "user",
        role: "user",
        time: { created: Date.now() },
        sessionID: SessionID.make("ses-daily-summary"),
        text: "",
      } as unknown as SessionV1.User

      const text = yield* llm
        .stream({
          agent: ag,
          user,
          system: [],
          small: true,
          tools: {},
          model,
          sessionID: "daily-summary",
          retries: 2,
          messages: [
            {
              role: "user",
              content:
                `这是 ${dateKey} 你在本机各 AI 工具（newhorse work、newhorse、Claude Code、Codex）中的当日活动记录。` +
                `请写一段简洁、分点式的中文「今日概览」，概括今天做了什么、有哪些进展和结论，` +
                `可引用会话标题，不要重复罗列文件。控制在 ${OVERVIEW_MAX_CHARS} 字以内：\n\n${digest}`,
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
      return cleaned || fallbackOverview(digest)
    })

    const generateOverview = Effect.fn("DailySummary.generateOverview")(function* (digest: string, dateKey: string) {
      // Anchor the LLM call to a real instance context (the 23:00 scheduler runs
      // in a global fiber with no InstanceRef). Any directory yields the same
      // provider/agent catalog; the load is cached by InstanceStore.
      const anchor = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(isNull(SessionTable.time_archived))
        .orderBy(desc(SessionTable.time_updated))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!anchor) return fallbackOverview(digest)
      return yield* instanceStore
        .provide({ directory: anchor.directory }, synthesize(digest, dateKey))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("daily summary synthesis failed", { cause }).pipe(
              Effect.as(fallbackOverview(digest)),
            ),
          ),
        )
    })

    // ---------------------------------------------------------------------
    // Draft: aggregate + overview (not persisted).
    // ---------------------------------------------------------------------
    const draft = Effect.fn("DailySummary.draft")(function* (input?: { date?: number }) {
      const date = new Date(input?.date ?? Date.now())
      const start = dayStartMs(date)
      const end = dayEndMs(date)
      const [agg, claude, codex] = yield* Effect.all([
        aggregate(date),
        readClaudeCode(fs, start, end),
        readCodex(fs, date, start, end),
      ])
      if (agg.sessions.length === 0 && claude.length === 0 && codex.length === 0) return undefined

      const dateKey = localDateKey(start)
      const lines: string[] = []
      for (const s of agg.sessions) {
        const todo = s.todos.length > 0 ? `；待办：${s.todos.map((t) => `${t.content}(${t.status})`).join("、")}` : ""
        lines.push(`[${sourceLabel(s.source)}] ${s.title}${s.filesChanged > 0 ? `（改动 ${s.filesChanged} 文件 +${s.additions} −${s.deletions}）` : ""}${todo}`)
      }
      if (claude.length > 0) lines.push(`[Claude Code] ${claude.join("；")}`)
      if (codex.length > 0) lines.push(`[Codex] ${codex.join("；")}`)

      const overview = yield* generateOverview(lines.join("\n"), dateKey)
      return {
        date: dateKey,
        overview,
        work: agg.work,
        sessions: agg.sessions,
        usage: agg.usage,
        generatedAt: Date.now(),
      } satisfies Report
    })

    const persist = Effect.fn("DailySummary.persist")(function* (report: Report) {
      yield* db
        .insert(DailySummaryTable)
        .values({ date: report.date, content: JSON.stringify(report) })
        .onConflictDoUpdate({
          target: DailySummaryTable.date,
          set: { content: JSON.stringify(report), time_updated: Date.now() },
        })
        .pipe(Effect.orDie)
    })

    const generate = Effect.fn("DailySummary.generate")(function* (input?: { date?: number }) {
      const report = yield* draft(input)
      if (!report) return undefined
      yield* persist(report)
      return report
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
      return decodeReport(row.date, row.content, row.time_created)
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
      return rows.map((row) => decodeReport(row.date, row.content, row.time_created))
    })

    // Every minute: once past 23:00 local, generate today's report if missing;
    // if today is already summarized but yesterday was missed, backfill one day.
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
  deps: [Database.node, FSUtil.node, Agent.node, Provider.node, LLM.node, Profile.node, InstanceStore.node],
})

export * as DailySummary from "./index"
