// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Tests ported from internal/agent/agent_test.go of the open-code-review
// project.

import { describe, expect, it } from "bun:test"
import {
  buildFilterCommentsJSON,
  parseFilterResponse,
  stripMarkdownFences,
} from "../../src/review/filter-comments"

describe("buildFilterCommentsJSON", () => {
  it("produces sequential c-N ids", () => {
    const json = buildFilterCommentsJSON([
      { path: "a.ts", content: "fix this", existingCode: "old code", startLine: 0, endLine: 0 },
      { path: "a.ts", content: "issue B", startLine: 0, endLine: 0 },
      { path: "a.ts", content: "issue C", existingCode: "x", startLine: 0, endLine: 0 },
    ])
    const items = JSON.parse(json) as { id: string; content: string; existing_code?: string }[]
    expect(items).toEqual([
      { id: "c-0", content: "fix this", existing_code: "old code" },
      { id: "c-1", content: "issue B" },
      { id: "c-2", content: "issue C", existing_code: "x" },
    ])
  })

  it("handles an empty list", () => {
    expect(buildFilterCommentsJSON([])).toBe("[]")
  })
})

describe("parseFilterResponse", () => {
  const cases: { name: string; raw: string; total: number; want: Set<number> | undefined }[] = [
    { name: "valid JSON array", raw: `["c-0","c-2","c-4"]`, total: 5, want: new Set([0, 2, 4]) },
    { name: "markdown fenced JSON", raw: "```json\n[\"c-1\"]\n```", total: 3, want: new Set([1]) },
    { name: "out-of-range indices ignored", raw: `["c-0","c-10","c-99"]`, total: 5, want: new Set([0]) },
    { name: "negative index ignored", raw: `["c--1","c-0"]`, total: 2, want: new Set([0]) },
    { name: "invalid ID format ignored", raw: `["x-0","c-abc","c-1"]`, total: 3, want: new Set([1]) },
    { name: "invalid JSON returns undefined", raw: `not json`, total: 5, want: undefined },
    { name: "empty array", raw: `[]`, total: 5, want: new Set() },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const got = parseFilterResponse(c.raw, c.total)
      if (c.want === undefined) {
        expect(got).toBeUndefined()
        return
      }
      expect(got).toEqual(c.want)
    })
  }
})

describe("stripMarkdownFences", () => {
  it("strips fenced blocks", () => {
    expect(stripMarkdownFences("```json\n[\"a\"]\n```")).toBe('["a"]')
    expect(stripMarkdownFences("```\nhello\n```")).toBe("hello")
    expect(stripMarkdownFences("plain")).toBe("plain")
    expect(stripMarkdownFences("```json")).toBe("")
  })
})
