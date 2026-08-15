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

function mockService(list: DailySummary.Interface["list"], generate: DailySummary.Interface["generate"]) {
  return DailySummary.Service.of({ list, generate })
}

describe("tool.daily-summary", () => {
  it.instance("lists daily summaries formatted with date and content", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      const mock = mockService(
        () =>
          Effect.succeed([
            { date: "2026-08-14", content: "完成了每日总结工具的接入。", timeCreated: 1_000 },
            { date: "2026-08-13", content: "修复了 session 权限问题。", timeCreated: 900 },
            { date: "2026-08-12", content: "梳理了 v1 路线图。", timeCreated: 800 },
          ]),
        () => Effect.succeed(""),
      )

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
      expect(result.output).toBe("2026-08-14: 完成了每日总结工具的接入。\n\n2026-08-13: 修复了 session 权限问题。")
    }),
  )

  it.instance("defaults limit to 7 and returns empty text when no summaries exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ profileID: Profile.ID.make("assistant") })

      const mock = mockService(() => Effect.succeed([]), () => Effect.succeed(""))
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
      const mock = mockService((input) => {
        captured = input
        return Effect.succeed([])
      }, () => Effect.succeed(""))
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
})
