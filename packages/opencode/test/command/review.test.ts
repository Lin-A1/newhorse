// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Unit tests for the native review command helpers.

import { describe, expect, it } from "bun:test"
import { formatReviewFindings, parseReviewArguments, reviewCommentMetadata } from "../../src/command/review"
import type { ReviewComment } from "../../src/review/types"

const comment = (d: Partial<ReviewComment>): ReviewComment => ({
  path: d.path ?? "src/a.ts",
  content: d.content ?? "off-by-one",
  startLine: d.startLine ?? 12,
  endLine: d.endLine ?? 14,
  severity: d.severity ?? "high",
  category: d.category ?? "bug",
  suggestionCode: d.suggestionCode,
  existingCode: d.existingCode,
  thinking: d.thinking,
})

describe("parseReviewArguments", () => {
  it("defaults to workspace when empty", () => {
    expect(parseReviewArguments("")).toEqual({ mode: "workspace" })
    expect(parseReviewArguments("   ")).toEqual({ mode: "workspace" })
  })

  it("parses commit mode", () => {
    expect(parseReviewArguments("commit abc123")).toEqual({ mode: "commit", commit: "abc123" })
    expect(parseReviewArguments("abc123")).toEqual({ mode: "commit", commit: "abc123" })
  })

  it("parses branch mode as a range against HEAD", () => {
    expect(parseReviewArguments("branch main")).toEqual({ mode: "range", from: "main", to: "HEAD" })
  })

  it("falls back to workspace for bare mode keywords without a ref", () => {
    expect(parseReviewArguments("commit")).toEqual({ mode: "workspace" })
    expect(parseReviewArguments("branch")).toEqual({ mode: "workspace" })
  })
})

describe("formatReviewFindings", () => {
  it("reports no issues for an empty result", () => {
    expect(formatReviewFindings([])).toContain("No issues were found")
  })

  it("lists each finding with path, line range, and severity", () => {
    const out = formatReviewFindings([comment({}), comment({ path: "src/b.ts", startLine: 0, endLine: 0 })])
    expect(out).toContain("2 issue(s) across 2 file(s)")
    expect(out).toContain("- src/a.ts:12-14 [high] off-by-one")
    // Unresolved line numbers render as "?".
    expect(out).toContain("- src/b.ts:? ")
  })
})

describe("reviewCommentMetadata", () => {
  it("attaches the comment under the stable key the app reads", () => {
    const metadata = reviewCommentMetadata(comment({}))
    expect(metadata.newhorseReview).toMatchObject({
      path: "src/a.ts",
      content: "off-by-one",
      startLine: 12,
      endLine: 14,
    })
  })
})
