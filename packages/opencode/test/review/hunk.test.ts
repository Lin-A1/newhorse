// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Tests ported from internal/diff/hunk_test.go of the open-code-review project.

import { describe, expect, it } from "bun:test"
import { parseHunks } from "../../src/review/hunk"

describe("parseHunks", () => {
  it("parses a single hunk with correct line types", () => {
    const raw = `diff --git a/pkg/example/handler.go b/pkg/example/handler.go
--- a/pkg/example/handler.go
+++ b/pkg/example/handler.go
@@ -10,7 +10,7 @@ func HandleRequest(w http.ResponseWriter, r *http.Request) {
     ctx := r.Context()
-    log.Print("handling request")
+    log.Printf("handling request: %s", r.URL.Path)
     err := process(ctx)`

    const hunks = parseHunks(raw)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]
    expect(h.oldStart).toBe(10)
    expect(h.oldCount).toBe(7)
    expect(h.newStart).toBe(10)
    expect(h.newCount).toBe(7)
    expect(h.lines).toHaveLength(4)
    expect(h.lines.map((l) => l.type)).toEqual(["context", "deleted", "added", "context"])
  })

  it("parses multiple hunks", () => {
    const raw = `diff --git a/pkg/example/handler.go b/pkg/example/handler.go
--- a/pkg/example/handler.go
+++ b/pkg/example/handler.go
@@ -10,3 +10,3 @@ func foo() {
     a := 1
-    b := 2
+    b := 3
     c := 4
@@ -25,6 +25,8 @@ func bar() {
     if err != nil {
         return err
     }
+    log.Print("ok")
+    log.Print("done")
     return nil`

    const hunks = parseHunks(raw)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].oldStart).toBe(10)
    expect(hunks[0].newStart).toBe(10)
    expect(hunks[1].oldStart).toBe(25)
    expect(hunks[1].newStart).toBe(25)
    expect(hunks[1].oldCount).toBe(6)
    expect(hunks[1].newCount).toBe(8)
  })

  it("skips the no-newline marker", () => {
    const raw = `@@ -1,2 +1,2 @@
-    old line
\\ No newline at end of file
+    new line`

    const hunks = parseHunks(raw)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines).toHaveLength(2)
  })

  it("returns no hunks for empty input", () => {
    expect(parseHunks("")).toHaveLength(0)
  })

  it("treats a new file as all additions", () => {
    const raw = `diff --git a/pkg/new.go b/pkg/new.go
new file mode 100644
--- /dev/null
+++ b/pkg/new.go
@@ -0,0 +1,3 @@
+package pkg
+
+func New() {}`

    const hunks = parseHunks(raw)
    expect(hunks).toHaveLength(1)
    for (const l of hunks[0].lines) {
      expect(l.type).toBe("added")
    }
  })
})
