import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { FSUtil } from "@newhorse/core/fs-util"
import { readClaudeCode, readCodex } from "../../src/daily-summary/readers"

const mkFs = (files: Record<string, string>): FSUtil.Interface =>
  ({
    glob: () => Effect.succeed(Object.keys(files)),
    readFileStringSafe: (p: string) => Effect.succeed(files[p]),
  }) as unknown as FSUtil.Interface

const dayStart = Date.UTC(2026, 7, 8, 0, 0, 0)
const dayEnd = Date.UTC(2026, 7, 9, 0, 0, 0)

describe("daily-summary readers", () => {
  test("readClaudeCode extracts in-day user messages", async () => {
    const fs = mkFs({
      "/a.jsonl": [
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello work" }] }, timestamp: "2026-08-08T10:00:00Z" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" }, timestamp: "2026-08-08T10:00:01Z" }),
        JSON.stringify({ type: "user", message: { role: "user", content: "out of day" }, timestamp: "2026-08-07T10:00:00Z" }),
      ].join("\n"),
    })
    const entries = await Effect.runPromise(readClaudeCode(fs, dayStart, dayEnd))
    expect(entries).toContain("hello work")
    expect(entries).not.toContain("hi")
    expect(entries).not.toContain("out of day")
  })

  test("readCodex extracts in-day user messages from payload", async () => {
    const fs = mkFs({
      "/c.jsonl": [
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "codex task" }] }, timestamp: "2026-08-08T09:00:00Z" }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "ok" }, timestamp: "2026-08-08T09:00:01Z" }),
      ].join("\n"),
    })
    const date = new Date(2026, 7, 8)
    const entries = await Effect.runPromise(readCodex(fs, date, dayStart, dayEnd))
    expect(entries).toContain("codex task")
    expect(entries).not.toContain("ok")
  })

  test("returns empty on missing files", async () => {
    const fs = mkFs({})
    const entries = await Effect.runPromise(readClaudeCode(fs, dayStart, dayEnd))
    expect(entries).toEqual([])
  })
})
