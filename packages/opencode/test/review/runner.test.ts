// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Unit tests for the review session's deterministic prompt rendering.

import { describe, expect, it } from "bun:test"
import type { ReviewDiff } from "../../src/review/types"
import {
  buildChangeFilesExcept,
  formatCurrentDateTime,
  renderMainTaskUser,
  renderReviewFilterUser,
} from "../../src/review/runner"

const diff = (d: Partial<ReviewDiff>): ReviewDiff => ({
  oldPath: d.oldPath ?? d.newPath ?? "",
  newPath: d.newPath ?? d.oldPath ?? "",
  diff: d.diff ?? "",
  newFileContent: d.newFileContent ?? "",
  isBinary: d.isBinary ?? false,
  isDeleted: d.isDeleted ?? false,
  isNew: d.isNew ?? false,
  isRenamed: d.isRenamed ?? false,
  insertions: d.insertions ?? 0,
  deletions: d.deletions ?? 0,
})

describe("formatCurrentDateTime", () => {
  it("formats as YYYY-MM-DD HH:MM", () => {
    const d = new Date(2026, 7, 13, 9, 5) // Aug 13, 09:05
    expect(formatCurrentDateTime(d)).toBe("2026-08-13 09:05")
  })
})

describe("buildChangeFilesExcept", () => {
  const diffs: ReviewDiff[] = [
    diff({ newPath: "a.ts" }),
    diff({ newPath: "b.go", isNew: true }),
    diff({ oldPath: "old.ts", newPath: "gone.ts", isDeleted: true }),
    diff({ oldPath: "r1.ts", newPath: "r2.ts", isRenamed: true }),
    diff({ newPath: "img.png", isBinary: true }),
    diff({ newPath: "c.ts" }),
  ]

  it("lists other changed files with statuses, excluding the current file and binaries", () => {
    const out = buildChangeFilesExcept(diffs, "a.ts")
    expect(out.split("\n")).toEqual([
      "ADDED   b.go",
      "DELETED   gone.ts",
      "RENAMED   r2.ts",
      "MODIFIED   c.ts",
    ])
  })
})

describe("renderMainTaskUser", () => {
  it("fills every placeholder", () => {
    const out = renderMainTaskUser({
      changeFiles: "MODIFIED   b.ts",
      filePath: "src/a.ts",
      diff: "@@ -1,1 +1,2 @@",
      currentDateTime: "2026-08-13 09:05",
      background: "fix the bug",
    })
    expect(out).toContain("MODIFIED   b.ts")
    expect(out).toContain("<current_file_path>src/a.ts</current_file_path>")
    expect(out).toContain("@@ -1,1 +1,2 @@")
    expect(out).toContain("2026-08-13 09:05")
    expect(out).toContain("fix the bug")
    // The optional placeholders must never leak through.
    expect(out).not.toContain("{{")
  })

  it("leaves empty background and plan placeholders clean", () => {
    const out = renderMainTaskUser({
      changeFiles: "",
      filePath: "a.ts",
      diff: "",
      currentDateTime: "",
    })
    expect(out).not.toContain("{{system_rule}}")
    expect(out).not.toContain("{{plan_guidance}}")
    expect(out).not.toContain("{{requirement_background}}")
  })
})

describe("renderReviewFilterUser", () => {
  it("fills path/diff/comments placeholders", () => {
    const out = renderReviewFilterUser({
      path: "src/a.ts",
      diff: "@@ -1 +1 @@",
      comments: '[{"id":"c-0","content":"x"}]',
    })
    expect(out).toContain("```src/a.ts")
    expect(out).toContain("@@ -1 +1 @@")
    expect(out).toContain('[{"id":"c-0","content":"x"}]')
    expect(out).not.toContain("{{")
  })
})
