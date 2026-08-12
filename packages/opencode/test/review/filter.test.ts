// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Tests ported from internal/agent/preview_test.go and
// internal/config/allowlist/*_test.go of the open-code-review project.

import { describe, expect, it } from "bun:test"
import {
  diffStatus,
  estimateTokens,
  extFromPath,
  filterDiffs,
  filterLargeDiffs,
  isAllowedExt,
  isExcludedPath,
  promptTokenLimit,
  shouldReview,
  whyExcluded,
  type UserFileFilter,
} from "../../src/review/filter"
import { effectivePath } from "../../src/review/git-diff"
import { EXCLUDE_BINARY, EXCLUDE_DEFAULT_PATH, EXCLUDE_EXTENSION, EXCLUDE_NONE, EXCLUDE_USER_RULE } from "../../src/review/types"
import type { ReviewDiff } from "../../src/review/types"

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

describe("whyExcluded", () => {
  it("binary files are excluded regardless of extension", () => {
    expect(whyExcluded(diff({ newPath: "image.png", isBinary: true }))).toBe(EXCLUDE_BINARY)
    expect(whyExcluded(diff({ newPath: "document.pdf", isBinary: true }))).toBe(EXCLUDE_BINARY)
    expect(whyExcluded(diff({ newPath: "main.go" }))).toBe(EXCLUDE_NONE)
  })

  it("user exclude patterns are honored", () => {
    const f: UserFileFilter = { exclude: ["vendor/**", "*.gen.go"] }
    expect(whyExcluded(diff({ newPath: "vendor/foo/bar.go" }), f)).toBe(EXCLUDE_USER_RULE)
    expect(whyExcluded(diff({ newPath: "api.gen.go" }), f)).toBe(EXCLUDE_USER_RULE)
    expect(whyExcluded(diff({ newPath: "main.go" }), f)).toBe(EXCLUDE_NONE)
  })

  it("unsupported extensions are excluded", () => {
    expect(whyExcluded(diff({ newPath: "README.txt" }))).toBe(EXCLUDE_EXTENSION)
    expect(whyExcluded(diff({ newPath: "docs/guide.md" }))).toBe(EXCLUDE_EXTENSION)
    expect(whyExcluded(diff({ newPath: "main.go" }))).toBe(EXCLUDE_NONE)
    expect(whyExcluded(diff({ newPath: "src/Main.java" }))).toBe(EXCLUDE_NONE)
    expect(whyExcluded(diff({ newPath: "app.ts" }))).toBe(EXCLUDE_NONE)
    expect(whyExcluded(diff({ newPath: "Makefile" }))).toBe(EXCLUDE_NONE)
  })

  it("default exclude patterns are honored", () => {
    expect(whyExcluded(diff({ newPath: "foo_test.go" }))).toBe(EXCLUDE_DEFAULT_PATH)
    expect(whyExcluded(diff({ newPath: "src/test/java/com/example/FooTest.java" }))).toBe(EXCLUDE_DEFAULT_PATH)
    expect(whyExcluded(diff({ newPath: "src/main/java/com/example/Foo.java" }))).toBe(EXCLUDE_NONE)
    expect(whyExcluded(diff({ newPath: "handler.go" }))).toBe(EXCLUDE_NONE)
  })

  it("include patterns bypass default-path exclusion", () => {
    const f: UserFileFilter = { include: ["src/**/*.go", "pkg/**/*.go", "**/*.supportedext"] }
    expect(whyExcluded(diff({ newPath: "src/foo/bar.go" }), f)).toBe(EXCLUDE_NONE)
    expect(whyExcluded(diff({ newPath: "pkg/util/helper.go" }), f)).toBe(EXCLUDE_NONE)
    // *_test.go would be default-excluded, but the include pattern wins.
    expect(whyExcluded(diff({ newPath: "src/foo/bar_test.go" }), f)).toBe(EXCLUDE_NONE)
    // Include is additive, not exclusive.
    expect(whyExcluded(diff({ newPath: "vendor/baz.go" }), f)).toBe(EXCLUDE_NONE)
    expect(whyExcluded(diff({ newPath: "internal/handler.go" }), f)).toBe(EXCLUDE_NONE)
    // Include overrides extension exclusion.
    expect(whyExcluded(diff({ newPath: "internal/test.supportedext" }), f)).toBe(EXCLUDE_NONE)
    // Unsupported extension still excluded even under an include dir.
    expect(whyExcluded(diff({ newPath: "src/notes.txt" }), f)).toBe(EXCLUDE_EXTENSION)
    // Non-included test file falls through to default exclusion.
    expect(whyExcluded(diff({ newPath: "internal/handler_test.go" }), f)).toBe(EXCLUDE_DEFAULT_PATH)
  })

  it("user exclude takes precedence over include", () => {
    const f: UserFileFilter = { include: ["src/**/*.go"], exclude: ["src/generated/**"] }
    expect(whyExcluded(diff({ newPath: "src/handler.go" }), f)).toBe(EXCLUDE_NONE)
    expect(whyExcluded(diff({ newPath: "src/generated/api.go" }), f)).toBe(EXCLUDE_USER_RULE)
    expect(whyExcluded(diff({ newPath: "lib/utils.go" }), f)).toBe(EXCLUDE_NONE)
  })

  it("binary check has the highest priority", () => {
    const f: UserFileFilter = { exclude: ["vendor/**"] }
    expect(whyExcluded(diff({ newPath: "vendor/image.png", isBinary: true }), f)).toBe(EXCLUDE_BINARY)
  })

  it("deleted files are not excluded here (handled at dispatch)", () => {
    expect(whyExcluded(diff({ oldPath: "gone.ts", newPath: "/dev/null", isDeleted: true }))).toBe(EXCLUDE_NONE)
  })
})

describe("shouldReview / filterDiffs", () => {
  it("shouldReview applies default filters", () => {
    expect(shouldReview(diff({ newPath: "main.go" }))).toBe(true)
    expect(shouldReview(diff({ newPath: "image.png", isBinary: true }))).toBe(false)
    expect(shouldReview(diff({ newPath: "main_test.go" }))).toBe(false)
    expect(shouldReview(diff({ newPath: "README.md" }))).toBe(false)
  })

  it("filterDiffs keeps only reviewable diffs", () => {
    const kept = filterDiffs([
      diff({ newPath: "a.go" }),
      diff({ newPath: "b.png", isBinary: true }),
      diff({ newPath: "c_test.go" }),
    ])
    expect(kept.map((d) => d.newPath)).toEqual(["a.go"])
  })
})

describe("effectivePath", () => {
  it("uses new path, or old path for deleted files", () => {
    expect(effectivePath(diff({ oldPath: "old.go", newPath: "new.go" }))).toBe("new.go")
    expect(effectivePath(diff({ oldPath: "deleted.go", newPath: "/dev/null" }))).toBe("deleted.go")
    expect(effectivePath(diff({ oldPath: "old_name.go", newPath: "new_name.go" }))).toBe("new_name.go")
  })
})

describe("diffStatus", () => {
  it("classifies binary/added/deleted/renamed/modified", () => {
    expect(diffStatus(diff({ isBinary: true }))).toBe("binary")
    expect(diffStatus(diff({ isNew: true }))).toBe("added")
    expect(diffStatus(diff({ isDeleted: true }))).toBe("deleted")
    expect(diffStatus(diff({ oldPath: "old.go", newPath: "new.go" }))).toBe("renamed")
    expect(diffStatus(diff({ oldPath: "main.go", newPath: "main.go" }))).toBe("modified")
  })
})

describe("extFromPath", () => {
  it("returns lowercased extension with dot", () => {
    expect(extFromPath("src/Main.JAVA")).toBe(".java")
    expect(extFromPath("app.ts")).toBe(".ts")
    expect(extFromPath("Makefile")).toBe("")
    expect(extFromPath(".gitignore")).toBe("")
  })
})

describe("isAllowedExt", () => {
  it("checks supported extensions case-insensitively", () => {
    expect(isAllowedExt(".go")).toBe(true)
    expect(isAllowedExt(".GO")).toBe(true)
    expect(isAllowedExt(".tsx")).toBe(true)
    expect(isAllowedExt(".md")).toBe(false)
    expect(isAllowedExt(".txt")).toBe(false)
  })
})

describe("isExcludedPath", () => {
  it("matches default exclude globs case-insensitively", () => {
    expect(isExcludedPath("foo_test.go")).toBe(true)
    expect(isExcludedPath("pkg/foo_test.go")).toBe(true)
    expect(isExcludedPath("src/__tests__/foo.test.ts")).toBe(true)
    expect(isExcludedPath("foo.spec.js")).toBe(true)
    expect(isExcludedPath("foo.gen.go")).toBe(true)
    expect(isExcludedPath("src/main.go")).toBe(false)
    expect(isExcludedPath("README.md")).toBe(false)
  })
})

describe("size threshold", () => {
  it("promptTokenLimit is 80% of maxTokens", () => {
    expect(promptTokenLimit(1000)).toBe(800)
    expect(promptTokenLimit(0)).toBe(0)
  })

  it("estimateTokens approximates bytes/4", () => {
    expect(estimateTokens("")).toBe(0)
    // "abc" is 3 bytes → ceil(3/4) = 1
    expect(estimateTokens("abc")).toBe(1)
    // 8 ASCII chars → 2 tokens
    expect(estimateTokens("abcdefgh")).toBe(2)
  })

  it("filterLargeDiffs drops diffs above 80% of maxTokens", () => {
    const small = diff({ newPath: "a.go", diff: "a".repeat(100) }) // ~25 tokens
    const large = diff({ newPath: "b.go", diff: "b".repeat(10000) }) // ~2500 tokens
    const kept = filterLargeDiffs([small, large], 2000) // limit 1600
    expect(kept.map((d) => d.newPath)).toEqual(["a.go"])
    // Disabled threshold keeps everything.
    expect(filterLargeDiffs([large], 0)).toHaveLength(1)
  })
})
