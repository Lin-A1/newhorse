// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Tests ported from internal/diff/parser_test.go of the open-code-review project.

import { $ } from "bun"
import { describe, expect, it } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Effect } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Git } from "../../src/git"
import { loadDiffs, parseDiffText, synthesizeUntrackedDiff } from "../../src/review/git-diff"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const itLive = testEffect(LayerNode.compile(LayerNode.group([Git.node]))).live

describe("parseDiffText", () => {
  it("strips index headers from the prompt diff", () => {
    const diffText = `diff --git a/first.go b/first.go
index 1234567..89abcde 100644
--- a/first.go
+++ b/first.go
@@ -1,1 +1,2 @@
 first
+index added-content
diff --git a/second.go b/second.go
new file mode 100644
index 0000000..7654321
--- /dev/null
+++ b/second.go
@@ -0,0 +1 @@
+package second
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(2)
    for (const d of diffs) {
      expect(d.diff.split("\n").some((l) => l.startsWith("index "))).toBe(false)
    }
    expect(diffs[0].diff).toContain("diff --git a/first.go b/first.go")
    expect(diffs[0].diff).toContain("+index added-content")
    expect(diffs[1].isNew).toBe(true)
  })

  it("recognizes a rename via rename from/to extended headers", () => {
    const diffText = `diff --git a/pkg/old name.go b/pkg/new name.go
similarity index 95%
rename from pkg/old name.go
rename to pkg/new name.go
index 1234567..89abcde 100644
--- a/pkg/old name.go
+++ b/pkg/new name.go
@@ -1,3 +1,3 @@
 line1
-line2
+line2 changed
 line3
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(1)
    const d = diffs[0]
    expect(d.isRenamed).toBe(true)
    expect(d.oldPath).toBe("pkg/old name.go")
    expect(d.newPath).toBe("pkg/new name.go")
    expect(d.isNew).toBe(false)
    expect(d.isDeleted).toBe(false)
  })

  it("handles a pure rename with no hunks", () => {
    const diffText = `diff --git a/old.go b/new.go
similarity index 100%
rename from old.go
rename to new.go
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(1)
    const d = diffs[0]
    expect(d.isRenamed).toBe(true)
    expect(d.oldPath).toBe("old.go")
    expect(d.newPath).toBe("new.go")
  })

  it("detects a deleted file via +++ /dev/null without the b/ prefix", () => {
    const diffText = `diff --git a/gone.go b/gone.go
deleted file mode 100644
index 1234567..0000000
--- a/gone.go
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(1)
    const d = diffs[0]
    expect(d.isDeleted).toBe(true)
    expect(d.newPath).toBe("/dev/null")
    expect(d.oldPath).toBe("gone.go")
  })

  it("detects a new file via --- /dev/null without the a/ prefix", () => {
    const diffText = `diff --git a/fresh.go b/fresh.go
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/fresh.go
@@ -0,0 +1,2 @@
+line1
+line2
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(1)
    const d = diffs[0]
    expect(d.isNew).toBe(true)
    expect(d.isDeleted).toBe(false)
    expect(d.insertions).toBe(2)
  })

  it("anchors the binary marker so a content mention is not classified binary", () => {
    const diffText = `diff --git a/docs.md b/docs.md
index 1234567..89abcde 100644
--- a/docs.md
+++ b/docs.md
@@ -1,2 +1,3 @@
 line1
+Note: Binary files are handled specially by git.
 line2
diff --git a/blob.bin b/blob.bin
index 1234567..89abcde 100644
Binary files a/blob.bin and b/blob.bin differ
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(2)
    expect(diffs[0].isBinary).toBe(false)
    expect(diffs[0].insertions).toBe(1)
    expect(diffs[1].isBinary).toBe(true)
  })

  it("counts content lines that themselves begin with ++ or --", () => {
    const diffText = `diff --git a/counter.go b/counter.go
index 1234567..89abcde 100644
--- a/counter.go
+++ b/counter.go
@@ -1,3 +1,3 @@
 func inc() {
---oldFlag
+++newFlag
 }
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(1)
    const d = diffs[0]
    expect(d.insertions).toBe(1)
    expect(d.deletions).toBe(1)
  })

  it("treats an added line rendering exactly as '+++ /dev/null' as content", () => {
    const diffText = `diff --git a/paths.txt b/paths.txt
index 1234567..89abcde 100644
--- a/paths.txt
+++ b/paths.txt
@@ -1,1 +1,2 @@
 first
+++ /dev/null
`
    const diffs = parseDiffText(diffText)
    expect(diffs).toHaveLength(1)
    const d = diffs[0]
    expect(d.isDeleted).toBe(false)
    expect(d.insertions).toBe(1)
  })
})

describe("synthesizeUntrackedDiff", () => {
  it("builds an all-additions diff with correct hunk header", () => {
    const content = "line1\nline2\nline3"
    const diff = synthesizeUntrackedDiff("newfile.ts", content)
    const lines = diff.split("\n")
    expect(lines[0]).toBe("diff --git a/newfile.ts b/newfile.ts")
    expect(lines[1]).toBe("--- /dev/null")
    expect(lines[2]).toBe("+++ b/newfile.ts")
    expect(lines[3]).toBe("@@ -0,0 +1,3 @@")
    expect(lines.slice(4)).toEqual(["+line1", "+line2", "+line3"])
  })

  it("handles a trailing newline without an extra blank added line", () => {
    const content = "a\nb\n"
    const diff = synthesizeUntrackedDiff("f.ts", content)
    expect(diff.split("\n")).toEqual([
      "diff --git a/f.ts b/f.ts",
      "--- /dev/null",
      "+++ b/f.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ])
  })

  it("counts a file without trailing newline correctly", () => {
    const diff = synthesizeUntrackedDiff("g.ts", "single")
    expect(diff.split("\n")).toEqual([
      "diff --git a/g.ts b/g.ts",
      "--- /dev/null",
      "+++ b/g.ts",
      "@@ -0,0 +1,1 @@",
      "+single",
    ])
  })

  it("handles empty content", () => {
    const diff = synthesizeUntrackedDiff("empty.ts", "")
    expect(diff.split("\n")).toEqual([
      "diff --git a/empty.ts b/empty.ts",
      "--- /dev/null",
      "+++ b/empty.ts",
      "@@ -0,0 +1,0 @@",
    ])
  })
})

describe("loadDiffs", () => {
  itLive("workspace mode surfaces tracked + untracked changes with gitignore exclusion", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const cwd = tmp.path

      yield* Effect.promise(() => $`git branch -M main`.cwd(cwd).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(cwd, "tracked.ts"), "line1\nline2\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(cwd).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "initial"`.cwd(cwd).quiet())

      // Modify the tracked file, add an untracked source file and an ignored log.
      yield* Effect.promise(() => fs.writeFile(path.join(cwd, "tracked.ts"), "line1\nline2 changed\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(cwd, "new.ts"), "export const x = 1\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(cwd, ".gitignore"), "*.log\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(cwd, "ignored.log"), "noise\n", "utf-8"))

      const git = yield* Git.Service
      const diffs = yield* loadDiffs(git, { cwd, mode: "workspace" })

      const byPath = new Map(diffs.map((d) => [d.newPath, d]))
      const tracked = byPath.get("tracked.ts")
      expect(tracked).toBeDefined()
      expect(tracked!.insertions).toBe(1)
      expect(tracked!.deletions).toBe(1)
      expect(tracked!.diff).toContain("+line2 changed")

      const untracked = byPath.get("new.ts")
      expect(untracked).toBeDefined()
      expect(untracked!.isNew).toBe(true)
      expect(untracked!.insertions).toBe(1)
      expect(untracked!.newFileContent).toBe("export const x = 1\n")

      // gitignore + hardcoded exclusion applies.
      expect(byPath.has("ignored.log")).toBe(false)
    }))
})

