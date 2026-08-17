import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@newhorse/sdk/v2"
import type { TimelineRow } from "./timeline-row"

mock.module("@newhorse/session-ui/message-part", () => {
  const groupParts = (parts: { messageID: string; part: { id: string } }[]) =>
    parts.map((item) => ({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: { messageID: item.messageID, partID: item.part.id },
    }))
  const renderable = () => true
  return { groupParts, renderable }
})

const { Timeline } = await import("./rows")

const textPart = {
  id: "prt-summary",
  type: "text",
  text: "the summary",
} as Part

const compactionPart = (overrides: Partial<{ compactedCount: number; compactedTokens: number }> = {}) =>
  ({
    id: "prt-compact",
    type: "compaction",
    auto: true,
    ...overrides,
  }) as Part

const userMessage = (id: string) => ({ id, role: "user" }) as unknown as UserMessage

const summaryAssistant = (completed?: number) =>
  ({
    id: "asst-summary",
    role: "assistant",
    parentID: "u1",
    summary: true,
    time: { created: 1, ...(completed !== undefined ? { completed } : {}) },
    tokens: { input: 0, output: 0 },
  }) as unknown as AssistantMessage

const buildRows = (userParts: Part[], assistant: AssistantMessage[]) =>
  Timeline.constructMessageRows(
    userMessage("u1"),
    (id) => (id === "asst-summary" ? [textPart] : userParts),
    assistant,
    0,
    false,
    "idle",
    false,
    false,
  )

describe("Timeline.constructMessageRows compaction", () => {
  test("renders a compacting placeholder while the summary turn is still in flight", () => {
    const result = buildRows([compactionPart()], [summaryAssistant()])
    expect(result).toHaveLength(1)
    const row = result[0] as TimelineRow.CompactionSummary
    expect(row.compacting).toBe(true)
    expect(row.summary).toBeUndefined()
    expect(row.messageCount).toBeUndefined()
    expect(row.tokenCount).toBeUndefined()
  })

  test("renders a formal marker once the summary completes", () => {
    const result = buildRows([compactionPart({ compactedCount: 4, compactedTokens: 1200 })], [summaryAssistant(5)])
    const row = result[0] as TimelineRow.CompactionSummary
    expect(row.compacting).toBe(false)
    expect(row.summary).toBe("the summary")
    expect(row.messageCount).toBe(4)
    expect(row.tokenCount).toBe(1200)
  })

  test("shows the compacted count for the first compaction at index 0", () => {
    const result = buildRows([compactionPart({ compactedCount: 2, compactedTokens: 500 })], [summaryAssistant(5)])
    const row = result[0] as TimelineRow.CompactionSummary
    expect(row.compacting).toBe(false)
    expect(row.messageCount).toBe(2)
    expect(row.tokenCount).toBe(500)
  })

  test("omits counts when the compaction part has none written yet", () => {
    const result = buildRows([compactionPart()], [summaryAssistant(5)])
    const row = result[0] as TimelineRow.CompactionSummary
    expect(row.compacting).toBe(false)
    expect(row.messageCount).toBeUndefined()
    expect(row.tokenCount).toBeUndefined()
  })
})
