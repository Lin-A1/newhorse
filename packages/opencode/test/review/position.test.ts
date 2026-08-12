// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Tests ported from internal/diff/resolver_test.go of the open-code-review
// project.

import { describe, expect, it } from "bun:test"
import type { ReviewDiff } from "../../src/review/types"
import {
  extractSideLines,
  matchConsecutive,
  normalizeLine,
  resolveLineNumbers,
  splitAndNormalize,
} from "../../src/review/position"
import type { Hunk, HunkLine } from "../../src/review/hunk"

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

const comment = (path: string, existingCode: string, lines?: Partial<{ startLine: number; endLine: number }>) => ({
  path,
  content: "comment",
  existingCode,
  startLine: lines?.startLine ?? 0,
  endLine: lines?.endLine ?? 0,
})

const testDiff = `diff --git a/pkg/example/handler.go b/pkg/example/handler.go
--- a/pkg/example/handler.go
+++ b/pkg/example/handler.go
@@ -10,7 +10,7 @@ func HandleRequest(w http.ResponseWriter, r *http.Request) {
     ctx := r.Context()
-    log.Print("handling request")
+    log.Printf("handling request: %s", r.URL.Path)
     err := process(ctx)`

describe("resolveLineNumbers", () => {
  it("resolves a single-line hunk match to the old-side line", () => {
    const result = resolveLineNumbers(
      [comment("pkg/example/handler.go", `    log.Print("handling request")`)],
      [diff({ newPath: "pkg/example/handler.go", diff: testDiff })],
    )
    expect(result[0].startLine).toBe(11)
    expect(result[0].endLine).toBe(11)
  })

  it("is whitespace tolerant", () => {
    const result = resolveLineNumbers(
      [comment("pkg/example/handler.go", `log.Print("handling request")`)],
      [diff({ newPath: "pkg/example/handler.go", diff: testDiff })],
    )
    expect(result[0].startLine).toBe(11)
    expect(result[0].endLine).toBe(11)
  })

  it("matches multi-line deleted code on the old side", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,4 +5,4 @@ import "fmt"
 func foo() {
-    x := 1
-    y := 2
+    x := 10
+    y := 20
 }`
    const result = resolveLineNumbers(
      [comment("test.go", `    x := 1
    y := 2`)],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(6)
    expect(result[0].endLine).toBe(7)
  })

  it("falls back to scanning new file content", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,3 +1,4 @@
 package main
+import "fmt"
 func foo() {}`
    const result = resolveLineNumbers(
      [comment("test.go", `package main
import "fmt"`)],
      [diff({ newPath: "test.go", diff: raw, newFileContent: `package main
import "fmt"
func foo() {}` })],
    )
    expect(result[0].startLine).toBe(1)
    expect(result[0].endLine).toBe(2)
  })

  it("fallback matches across blank lines", () => {
    const result = resolveLineNumbers(
      [comment("main.go", "func foo() {\n\treturn 1\n}")],
      [
        diff({
          newPath: "main.go",
          newFileContent: "package main\n\nfunc foo() {\n\n\treturn 1\n}",
          diff: "@@ -1,2 +1,2 @@\n-old\n+new",
        }),
      ],
    )
    expect(result[0].startLine).toBe(3)
    expect(result[0].endLine).toBe(6)
  })

  it("fallback matches across multiple blank lines", () => {
    const result = resolveLineNumbers(
      [comment("main.go", "a\nb\nc")],
      [diff({ newPath: "main.go", newFileContent: "a\n\n\nb\n\nc\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })],
    )
    expect(result[0].startLine).toBe(1)
    expect(result[0].endLine).toBe(6)
  })

  it("fallback handles leading blanks", () => {
    const result = resolveLineNumbers(
      [comment("main.go", "foo\nbar")],
      [diff({ newPath: "main.go", newFileContent: "\n\nfoo\nbar\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })],
    )
    expect(result[0].startLine).toBe(3)
    expect(result[0].endLine).toBe(4)
  })

  it("fallback handles CRLF line endings", () => {
    const result = resolveLineNumbers(
      [comment("main.go", "beta\ngamma")],
      [diff({ newPath: "main.go", newFileContent: "alpha\r\nbeta\r\ngamma\r\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })],
    )
    expect(result[0].startLine).toBe(2)
    expect(result[0].endLine).toBe(3)
  })

  it("first match wins", () => {
    const result = resolveLineNumbers(
      [comment("main.go", "x\ny")],
      [diff({ newPath: "main.go", newFileContent: "x\ny\nx\ny\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })],
    )
    expect(result[0].startLine).toBe(1)
    expect(result[0].endLine).toBe(2)
  })

  it("all-blank existing code keeps zero lines", () => {
    const result = resolveLineNumbers(
      [comment("main.go", "\n\n\n")],
      [diff({ newPath: "main.go", newFileContent: "a\nb\nc\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })],
    )
    expect(result[0].startLine).toBe(0)
    expect(result[0].endLine).toBe(0)
  })

  it("no match keeps zero lines", () => {
    const result = resolveLineNumbers(
      [comment("test.go", `totally unrelated code`)],
      [diff({ newPath: "test.go", diff: testDiff })],
    )
    expect(result[0].startLine).toBe(0)
    expect(result[0].endLine).toBe(0)
  })

  it("missing existing_code keeps zero lines", () => {
    const c = { path: "test.go", content: "comment", existingCode: "", startLine: 0, endLine: 0 }
    const result = resolveLineNumbers([c], [diff({ newPath: "test.go", diff: testDiff })])
    expect(result[0].startLine).toBe(0)
  })

  it("unknown path keeps zero lines", () => {
    const result = resolveLineNumbers(
      [comment("missing.go", `some code`)],
      [diff({ newPath: "other.go", diff: testDiff })],
    )
    expect(result[0].startLine).toBe(0)
  })

  it("empty inputs return unchanged", () => {
    expect(resolveLineNumbers([], [diff({})])).toHaveLength(0)
    const r2 = resolveLineNumbers([{ path: "x", content: "c", startLine: 0, endLine: 0 }], [])
    expect(r2).toHaveLength(1)
    expect(r2[0].startLine).toBe(0)
  })

  it("already resolved lines are preserved", () => {
    const result = resolveLineNumbers(
      [comment("test.go", `log.Print("handling request")`, { startLine: 99, endLine: 99 })],
      [diff({ newPath: "test.go", diff: testDiff })],
    )
    expect(result[0].startLine).toBe(99)
    expect(result[0].endLine).toBe(99)
  })
})

describe("resolveFromHunk behavior", () => {
  it("resolves added lines to new-side line numbers", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -3,3 +3,5 @@
 func main() {
+    x := 1
+    y := 2
     fmt.Println("hello")
 }`
    const result = resolveLineNumbers(
      [comment("test.go", `    x := 1
    y := 2`)],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(4)
    expect(result[0].endLine).toBe(5)
  })

  it("matches old-side across added lines", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,3 +5,4 @@
     x := 1
+    z := 99
     y := 2
 }`
    const result = resolveLineNumbers(
      [comment("test.go", `    x := 1
    y := 2`)],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(5)
    expect(result[0].endLine).toBe(6)
  })

  it("matches context lines", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -3,3 +3,4 @@
 func main() {
     fmt.Println("hello")
+    fmt.Println("world")
 }`
    const result = resolveLineNumbers(
      [comment("test.go", `    fmt.Println("hello")`)],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(4)
  })

  it("new-side takes priority over old-side", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,3 +8,4 @@
 func main() {
     fmt.Println("hello")
+    fmt.Println("world")
 }`
    const result = resolveLineNumbers(
      [comment("test.go", `    fmt.Println("hello")`)],
      [diff({ newPath: "test.go", diff: raw })],
    )
    // new-side: func main(8), fmt.Println("hello")(9) → line 9
    expect(result[0].startLine).toBe(9)
  })

  it("matches in a later hunk", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -2,3 +2,3 @@
 func foo() {
-    old1()
+    new1()
 }
@@ -20,3 +20,4 @@
 func bar() {
+    added_in_bar()
     existing()
 }`
    const result = resolveLineNumbers(
      [comment("test.go", "    added_in_bar()")],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(21)
    expect(result[0].endLine).toBe(21)
  })

  it("matches added lines plus surrounding context", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -10,3 +10,5 @@
 func process() {
+    validate()
+    transform()
     save()
 }`
    const result = resolveLineNumbers(
      [comment("test.go", `    validate()
    transform()
    save()`)],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(11)
    expect(result[0].endLine).toBe(13)
  })

  it("matches new-side across deleted lines", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,4 +5,3 @@
     a := 1
-    unused := 0
     b := 2
 }`
    const result = resolveLineNumbers(
      [comment("test.go", `    a := 1
    b := 2`)],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(5)
    expect(result[0].endLine).toBe(6)
  })

  it("resolves comments on both sides of a multi-hunk diff", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,4 +1,6 @@
 package main
+import "fmt"
+import "os"
 func main() {
-    old()
+    new()
 }`
    const result = resolveLineNumbers(
      [
        comment("test.go", `import "fmt"`),
        comment("test.go", `import "os"`),
        comment("test.go", "    old()"),
      ],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(2)
    expect(result[1].startLine).toBe(3)
    // deleted old() → old-side line 3
    expect(result[2].startLine).toBe(3)
  })

  it("maps comments referencing the old path of a rename", () => {
    const raw = `diff --git a/old_name.go b/new_name.go
--- a/old_name.go
+++ b/new_name.go
@@ -1,3 +1,3 @@
 package main
-func oldFunc() {}
+func newFunc() {}`
    const result = resolveLineNumbers(
      [comment("old_name.go", "func oldFunc() {}")],
      [diff({ oldPath: "old_name.go", newPath: "new_name.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(2)
    expect(result[0].endLine).toBe(2)
  })

  it("strips diff markers from existing_code", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,2 +1,3 @@
 x := 1
+y := 2
 z := 3`
    const result = resolveLineNumbers(
      [comment("test.go", "+y := 2")],
      [diff({ newPath: "test.go", diff: raw })],
    )
    expect(result[0].startLine).toBe(2)
    expect(result[0].endLine).toBe(2)
  })

  it("mixed strategies: hunk, file fallback, no match", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,3 +5,4 @@
 func foo() {
+    newLine()
     bar()
 }`
    const result = resolveLineNumbers(
      [
        comment("test.go", "    newLine()"),
        comment("test.go", "func helper() {}"),
        comment("test.go", "this_does_not_exist_anywhere()"),
      ],
      [
        diff({
          newPath: "test.go",
          diff: raw,
          newFileContent: "package main\nimport \"fmt\"\n\nfunc helper() {}\nfunc foo() {\n    newLine()\n    bar()\n}",
        }),
      ],
    )
    expect(result[0].startLine).toBe(6)
    expect(result[1].startLine).toBe(4)
    expect(result[2].startLine).toBe(0)
  })
})

describe("extractSideLines", () => {
  const hunk = (): Hunk => ({
    oldStart: 10,
    oldCount: 3,
    newStart: 10,
    newCount: 4,
    lines: [
      { type: "context", content: "    ctx := r.Context()" },
      { type: "deleted", content: `    log.Print("old")` },
      { type: "added", content: `    log.Printf("new: %s", r.URL)` },
      { type: "context", content: "    err := process(ctx)" },
    ] as HunkLine[],
  })

  it("extracts new-side context + added lines", () => {
    const got = extractSideLines(hunk(), true)
    expect(got).toEqual([
      { lineNum: 10, content: "ctx := r.Context()" },
      { lineNum: 11, content: `log.Printf("new: %s", r.URL)` },
      { lineNum: 12, content: "err := process(ctx)" },
    ])
  })

  it("extracts old-side context + deleted lines", () => {
    const got = extractSideLines(hunk(), false)
    expect(got).toEqual([
      { lineNum: 10, content: "ctx := r.Context()" },
      { lineNum: 11, content: `log.Print("old")` },
      { lineNum: 12, content: "err := process(ctx)" },
    ])
  })

  it("handles divergent start lines", () => {
    const h: Hunk = {
      oldStart: 5,
      oldCount: 2,
      newStart: 8,
      newCount: 3,
      lines: [
        { type: "context", content: "A" },
        { type: "added", content: "B" },
        { type: "context", content: "C" },
      ],
    }
    expect(extractSideLines(h, true).map((l) => l.lineNum)).toEqual([8, 9, 10])
    expect(extractSideLines(h, false).map((l) => l.lineNum)).toEqual([5, 6])
  })

  it("only-added hunks have no old side", () => {
    const h: Hunk = { oldStart: 1, oldCount: 0, newStart: 1, newCount: 2, lines: [{ type: "added", content: "l1" }, { type: "added", content: "l2" }] }
    expect(extractSideLines(h, true)).toHaveLength(2)
    expect(extractSideLines(h, false)).toHaveLength(0)
  })

  it("only-deleted hunks have no new side", () => {
    const h: Hunk = { oldStart: 3, oldCount: 2, newStart: 3, newCount: 0, lines: [{ type: "deleted", content: "old1" }, { type: "deleted", content: "old2" }] }
    const oldSide = extractSideLines(h, false)
    expect(oldSide.map((l) => l.lineNum)).toEqual([3, 4])
    expect(extractSideLines(h, true)).toHaveLength(0)
  })
})

describe("matchConsecutive", () => {
  const lines = (pairs: [number, string][]) => pairs.map(([lineNum, content]) => ({ lineNum, content }))

  it("matches a single line", () => {
    expect(matchConsecutive(lines([[5, "hello"], [6, "world"], [7, "foo"]]), ["world"])).toEqual({ start: 6, end: 6 })
  })

  it("matches multiple lines", () => {
    expect(matchConsecutive(lines([[1, "a"], [2, "b"], [3, "c"], [4, "d"]]), ["b", "c"])).toEqual({ start: 2, end: 3 })
  })

  it("returns undefined on no match", () => {
    expect(matchConsecutive(lines([[1, "a"], [2, "b"]]), ["x"])).toBeUndefined()
  })

  it("first match wins", () => {
    expect(matchConsecutive(lines([[10, "x"], [11, "y"], [20, "x"], [21, "y"]]), ["x", "y"])).toEqual({ start: 10, end: 11 })
  })

  it("returns undefined when target is longer", () => {
    expect(matchConsecutive(lines([[1, "a"]]), ["a", "b"])).toBeUndefined()
  })

  it("returns undefined on empty side lines", () => {
    expect(matchConsecutive([], ["a"])).toBeUndefined()
  })

  it("matches at the end and at the start", () => {
    expect(matchConsecutive(lines([[1, "a"], [2, "b"], [3, "c"]]), ["b", "c"])).toEqual({ start: 2, end: 3 })
    expect(matchConsecutive(lines([[1, "a"], [2, "b"], [3, "c"]]), ["a", "b"])).toEqual({ start: 1, end: 2 })
    expect(matchConsecutive(lines([[1, "a"], [2, "b"]]), ["a", "b"])).toEqual({ start: 1, end: 2 })
  })
})

describe("normalizeLine / splitAndNormalize", () => {
  it("normalizes whitespace and diff markers", () => {
    expect(normalizeLine("  hello  ")).toBe("hello")
    expect(normalizeLine("+added line")).toBe("added line")
    expect(normalizeLine("-deleted line")).toBe("deleted line")
    expect(normalizeLine("\tindented\t")).toBe("indented")
    expect(normalizeLine("")).toBe("")
  })

  it("skips empty lines in splitAndNormalize", () => {
    const lines = splitAndNormalize("line1\n\nline2")
    expect(lines).toEqual(["line1", "line2"])
  })
})
