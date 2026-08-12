// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Tests ported from internal/tool/comment_collector_test.go of the
// open-code-review project.

import { describe, expect, it } from "bun:test"
import { ReviewCollectorImpl } from "../../src/review/collector"
import type { ReviewComment } from "../../src/review/types"

const cm = (path: string, content: string): ReviewComment => ({
  path,
  content,
  startLine: 0,
  endLine: 0,
})

describe("ReviewCollector", () => {
  it("adds and returns all comments", () => {
    const c = new ReviewCollectorImpl()
    c.add(cm("a.ts", "issue 1"))
    c.add(cm("a.ts", "issue 2"))
    expect(c.comments()).toHaveLength(2)
  })

  it("commentsForPath filters by path", () => {
    const c = new ReviewCollectorImpl()
    c.add(cm("a.ts", "issue 1"))
    c.add(cm("b.ts", "issue 2"))
    c.add(cm("a.ts", "issue 3"))
    expect(c.commentsForPath("a.ts").map((x) => x.content)).toEqual(["issue 1", "issue 3"])
    expect(c.commentsForPath("missing.ts")).toHaveLength(0)
  })

  it("removeByPathAndIndices removes per-path indices", () => {
    const c = new ReviewCollectorImpl()
    c.add(cm("a.ts", "a0"))
    c.add(cm("b.ts", "b0"))
    c.add(cm("a.ts", "a1"))
    c.add(cm("b.ts", "b1"))
    c.add(cm("a.ts", "a2"))

    c.removeByPathAndIndices("a.ts", new Set([1]))
    // a.ts keeps a0 and a2 (a1 removed); b.ts untouched.
    expect(c.comments().map((x) => x.content)).toEqual(["a0", "b0", "b1", "a2"])
    expect(c.commentsForPath("a.ts").map((x) => x.content)).toEqual(["a0", "a2"])
  })

  it("removeByPathAndIndices with empty set is a no-op", () => {
    const c = new ReviewCollectorImpl()
    c.add(cm("a.ts", "a0"))
    c.add(cm("a.ts", "a1"))
    c.removeByPathAndIndices("a.ts", new Set())
    expect(c.comments()).toHaveLength(2)
  })

  it("removeByPathAndIndices removes everything for a path when all indices present", () => {
    const c = new ReviewCollectorImpl()
    c.add(cm("a.ts", "a0"))
    c.add(cm("b.ts", "b0"))
    c.add(cm("a.ts", "a1"))
    c.removeByPathAndIndices("a.ts", new Set([0, 1]))
    expect(c.comments().map((x) => x.content)).toEqual(["b0"])
  })

  it("comments() returns a defensive copy", () => {
    const c = new ReviewCollectorImpl()
    c.add(cm("a.ts", "a0"))
    const copy = c.comments()
    copy.push(cm("x.ts", "x"))
    expect(c.comments()).toHaveLength(1)
  })
})
