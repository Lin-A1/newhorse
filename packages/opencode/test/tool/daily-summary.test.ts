import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { SessionProjector } from "@newhorse/core/session/projector"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Profile } from "@/profile"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { DailySummary } from "@/daily-summary"
import { DailySummaryTool } from "@/tool/daily-summary"
import { Truncate } from "@/tool/truncate"
import type * as Tool from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, Profile.node, Truncate.node, Agent.node]),
  ),
)

function mockService(input: {
  list?: DailySummary.Interface["list"]
  generate?: DailySummary.Interface["generate"]
  draft?: DailySummary.Interface["draft"]
  get?: DailySummary.Interface["get"]
} = {}) {
  const emptyReport: DailySummary.Report = {
    date: "2026-08-15",
    overview: "",
    work: [],
    sessions: [],
    usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, sessions: 0, models: [] },
    generatedAt: 0,
  }
  return DailySummary.Service.of({
    list: input.list ?? (() => Effect.succeed([])),
    generate: input.generate ?? (() => Effect.succeed(emptyReport)),
    draft: input.draft ?? (() => Effect.succeed(emptyReport)),
    get: input.get ?? (() => Effect.succeed(undefined)),
  })
}

function report(date: string, overview: string, generatedAt = 1_000): DailySummary.Report {
  return {
    date,
    overview,
    work: [],
    sessions: [],
    usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, sessions: 0, models: [] },
    generatedAt,
  }
}

describe("tool.daily-summary", () => {
  it.instance("lists daily summaries formatted with date and content", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      const mock = mockService({
        list: () =>
          Effect.succeed([
            report("2026-08-14", "完成了每日总结工具的接入。"),
            report("2026-08-13", "修复了 session 权限问题。", 900),
            report("2026-08-12", "梳理了 v1 路线图。", 800),
          ]),
      })

      const info = yield* DailySummaryTool.pipe(Effect.provideService(DailySummary.Service, mock))
      const tool = yield* info.init()
      const result = yield* tool.execute(
        { limit: 2 },
        {
          sessionID: session.id,
          messageID: MessageID.make("msg_daily_summary_test"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.title).toBe("2 daily summaries")
      expect(result.metadata).toMatchObject({ count: 2, profile: Profile.ID.make("assistant") })
      expect(result.output).toBe("2026-08-14：\n完成了每日总结工具的接入。\n\n2026-08-13：\n修复了 session 权限问题。")
    }),
  )

  it.instance("defaults limit to 7 and returns empty text when no summaries exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      const mock = mockService()
      const info = yield* DailySummaryTool.pipe(Effect.provideService(DailySummary.Service, mock))
      const tool = yield* info.init()
      const result = yield* tool.execute(
        {},
        {
          sessionID: session.id,
          messageID: MessageID.make("msg_daily_summary_empty"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.title).toBe("0 daily summaries")
      expect(result.metadata).toMatchObject({ count: 0, profile: Profile.ID.make("assistant") })
      expect(result.output).toBe("暂无每日总结记录。")
    }),
  )

  it.instance("passes from/to through to the service list call", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      let captured: { from?: number; to?: number } | undefined
      const mock = mockService({
        list: (input) => {
          captured = input
          return Effect.succeed([])
        },
      })
      const info = yield* DailySummaryTool.pipe(Effect.provideService(DailySummary.Service, mock))
      const tool = yield* info.init()
      yield* tool.execute(
        { from: 100, to: 200 },
        {
          sessionID: session.id,
          messageID: MessageID.make("msg_daily_summary_range"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(captured).toEqual({ from: 100, to: 200 })
    }),
  )

  it.instance("generates and persists a fresh summary when none exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      let generatedWith: { date?: number } | undefined
      const mock = mockService({
        generate: (input) => {
          generatedWith = input
          return Effect.succeed(report("2026-08-15", "今天完成了每日总结工具的接入。"))
        },
      })
      const info = yield* DailySummaryTool.pipe(Effect.provideService(DailySummary.Service, mock))
      const tool = yield* info.init()
      const result = yield* tool.execute(
        { action: "generate" },
        {
          sessionID: session.id,
          messageID: MessageID.make("msg_daily_summary_generate"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(generatedWith?.date).toBeTypeOf("number")
      expect(result.metadata).toMatchObject({ count: 1, profile: Profile.ID.make("assistant") })
      expect(result.metadata).not.toHaveProperty("alreadyExists")
      expect(result.output).toBe("今天完成了每日总结工具的接入。")
    }),
  )

  it.instance("reports existing + fresh draft without persisting when a summary already exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      let generateCalled = false
      const mock = mockService({
        get: () =>
          Effect.succeed(report("2026-08-15", "已有总结：上午修了 bug。")),
        draft: () => Effect.succeed(report("2026-08-15", "新总结：下午接入每日总结工具。")),
        generate: () => {
          generateCalled = true
          return Effect.succeed(report("2026-08-15", "should not be reached"))
        },
      })
      const info = yield* DailySummaryTool.pipe(Effect.provideService(DailySummary.Service, mock))
      const tool = yield* info.init()
      const result = yield* tool.execute(
        { action: "generate" },
        {
          sessionID: session.id,
          messageID: MessageID.make("msg_daily_summary_exists"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(generateCalled).toBe(false)
      expect(result.metadata).toMatchObject({ count: 1, profile: Profile.ID.make("assistant"), alreadyExists: true })
      expect(result.output).toContain("已有总结：上午修了 bug。")
      expect(result.output).toContain("新总结：下午接入每日总结工具。")
      expect(result.output).toContain("overwrite")
    }),
  )

  it.instance("overwrites the existing summary when overwrite is true", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      let generatedWith: { date?: number } | undefined
      const mock = mockService({
        get: () =>
          Effect.succeed(report("2026-08-15", "已有总结：上午修了 bug。")),
        generate: (input) => {
          generatedWith = input
          return Effect.succeed(report("2026-08-15", "覆盖后的总结。"))
        },
      })
      const info = yield* DailySummaryTool.pipe(Effect.provideService(DailySummary.Service, mock))
      const tool = yield* info.init()
      const result = yield* tool.execute(
        { action: "generate", overwrite: true },
        {
          sessionID: session.id,
          messageID: MessageID.make("msg_daily_summary_overwrite"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(generatedWith?.date).toBeTypeOf("number")
      expect(result.metadata).toMatchObject({ count: 1, profile: Profile.ID.make("assistant"), overwritten: true })
      expect(result.output).toBe("覆盖后的总结。")
    }),
  )

  it.instance("reports no activity when generate finds no sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      const mock = mockService({ generate: () => Effect.succeed(undefined) })
      const info = yield* DailySummaryTool.pipe(Effect.provideService(DailySummary.Service, mock))
      const tool = yield* info.init()
      const result = yield* tool.execute(
        { action: "generate" },
        {
          sessionID: session.id,
          messageID: MessageID.make("msg_daily_summary_no_activity"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.metadata).toMatchObject({ count: 0, profile: Profile.ID.make("assistant") })
      expect(result.output).toContain("没有可总结的会话活动")
    }),
  )
})
