// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Tests for the review-only tools, ported from
// internal/tool/code_comment_test.go and the tool schemas in
// internal/config/toolsconfig/tools.json of the open-code-review project.

import { describe, expect, it } from "bun:test"
import { Layer, Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { EffectBridge } from "../../src/effect/bridge"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool/truncate"
import * as Tool from "../../src/tool/tool"
import { ReviewCollectorImpl } from "../../src/review/collector"
import {
  buildReviewTools,
  codeComment,
  codeCommentArgsToComments,
  COMMENT_SUCCEED,
  fileReadDiff,
  formatFileReadDiff,
  taskDone,
  taskDoneResult,
  toAITool,
  type ReviewToolContext,
} from "../../src/review/tools"
import type { Context as ToolContext } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const stubAgent = Agent.Service.of({
  get: () =>
    Effect.succeed({ name: "review", mode: "primary", permission: [] } as unknown as Agent.Info),
  list: () => Effect.succeed([]),
  defaultInfo: () =>
    Effect.succeed({ name: "review", mode: "primary", permission: [] } as unknown as Agent.Info),
  defaultAgent: () => Effect.succeed("review"),
  generate: () =>
    Effect.fail(Object.assign(new Error("n/a"), { _tag: "ProviderDefaultModelError" }) as never),
} as unknown as Agent.Interface)

const stubTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: (text: string) => Effect.succeed(text),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} as unknown as Truncate.Interface)

const stubLayer = Layer.mergeAll(
  Layer.succeed(Agent.Service, stubAgent),
  Layer.succeed(Truncate.Service, stubTruncate),
)

const itEffect = testEffect(stubLayer)

const fakeContext = (): ToolContext => ({
  sessionID: SessionID.make("ses-review"),
  messageID: MessageID.make("msg-review-test"),
  agent: "review",
  abort: new AbortController().signal,
  callID: "call-1",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("codeCommentArgsToComments", () => {
  it("injects the path and maps fields", () => {
    const comments = codeCommentArgsToComments(
      {
        comments: [
          {
            content: "fix this",
            existing_code: "const x = 1",
            suggestion_code: "const y = 2",
            category: "bug",
            severity: "high",
          },
        ],
      },
      "src/a.ts",
    )
    expect(comments).toEqual([
      {
        path: "src/a.ts",
        content: "fix this",
        existingCode: "const x = 1",
        suggestionCode: "const y = 2",
        thinking: undefined,
        category: "bug",
        severity: "high",
        startLine: 0,
        endLine: 0,
      },
    ])
  })

  it("defaults category and severity", () => {
    const comments = codeCommentArgsToComments({ comments: [{ content: "note" }] }, "src/a.ts")
    expect(comments[0].category).toBe("other")
    expect(comments[0].severity).toBe("low")
  })

  it("skips empty content", () => {
    const comments = codeCommentArgsToComments({ comments: [{ content: "" }] }, "src/a.ts")
    expect(comments).toHaveLength(0)
  })
})

describe("formatFileReadDiff", () => {
  it("renders diffs for requested paths", () => {
    const map = new Map([["a.ts", "@@ -1,1 +1,2 @@\n+new"], ["b.ts", "@@ -2,2 +2,1 @@\n-old"]])
    const out = formatFileReadDiff(map, ["a.ts", "b.ts"])
    expect(out).toBe(`==== FILE: a.ts ====
@@ -1,1 +1,2 @@
+new

==== FILE: b.ts ====
@@ -2,2 +2,1 @@
-old`)
  })

  it("skips unknown paths and reports not-found when nothing resolves", () => {
    const map = new Map([["a.ts", "@@ -1,1 +1,1 @@\n+x"]])
    expect(formatFileReadDiff(map, ["missing.ts"])).toBe("Error: diff not found for the requested paths")
    expect(formatFileReadDiff(map, ["a.ts", "missing.ts"])).toContain("==== FILE: a.ts ====")
  })
})

describe("taskDoneResult", () => {
  it("maps DONE to success and FAILED to failure", () => {
    expect(taskDoneResult("DONE")).toEqual({ failed: false, output: "Task complete." })
    expect(taskDoneResult("FAILED")).toEqual({ failed: true, output: "task_done reported FAILED" })
    expect(taskDoneResult(undefined)).toEqual({ failed: false, output: "Task complete." })
  })
})

describe("review tools via Tool.define", () => {
  itEffect.effect("code_comment adds comments to the collector and returns success", () =>
    Effect.gen(function* () {
      const collector = new ReviewCollectorImpl()
      const info = yield* codeComment(collector, "src/a.ts")
      const def = yield* Tool.init(info)
      const result = yield* def.execute(
        {
          comments: [
            { content: "issue A", existing_code: "const x = 1", category: "bug", severity: "high" },
            { content: "issue B", existing_code: "const y = 2" },
          ],
        } as never,
        fakeContext(),
      )
      expect(result.output).toBe(COMMENT_SUCCEED)
      const comments = collector.comments()
      expect(comments).toHaveLength(2)
      expect(comments[0].path).toBe("src/a.ts")
      expect(comments[1].category).toBe("other")
      expect(comments[1].severity).toBe("low")
    }))

  itEffect.effect("task_done reports DONE by default and FAILED when asked", () =>
    Effect.gen(function* () {
      const done: string[] = []
      const info = yield* taskDone((state) => done.push(state))
      const def = yield* Tool.init(info)
      const ok = yield* def.execute({} as never, fakeContext())
      expect(ok.output).toBe("Task complete.")
      const failed = yield* def.execute({ state: "FAILED" } as never, fakeContext())
      expect(failed.output).toBe("task_done reported FAILED")
      expect(done).toEqual(["DONE", "FAILED"])
    }))

  itEffect.effect("file_read_diff returns the diff for a path", () =>
    Effect.gen(function* () {
      const map = new Map([["b.ts", "@@ -1,1 +1,2 @@\n+added"]])
      const info = yield* fileReadDiff(map)
      const def = yield* Tool.init(info)
      const result = yield* def.execute({ path_array: ["b.ts", "missing.ts"] } as never, fakeContext())
      expect(result.output).toBe(`==== FILE: b.ts ====
@@ -1,1 +1,2 @@
+added`)
    }))
})

describe("buildReviewTools", () => {
  itEffect.effect("assembles the three review-only tools", () =>
    Effect.gen(function* () {
      const collector = new ReviewCollectorImpl()
      const tools = yield* buildReviewTools({
        collector,
        filePath: "src/a.ts",
        diffMap: new Map([["b.ts", "@@ -1 +1 @@\n+x"]]),
        onTaskDone: () => {},
        context: {
          sessionID: SessionID.make("ses-review"),
          messageID: MessageID.make("msg-review-test"),
          agent: "review",
          abort: new AbortController().signal,
          messages: [],
        } as ReviewToolContext,
        existing: new Map(),
      })

      expect(Object.keys(tools).sort()).toEqual(["code_comment", "file_read_diff", "task_done"])

      // Execute code_comment through the AI-SDK surface.
      yield* Effect.promise(() =>
        tools["code_comment"]!.execute!(
          { comments: [{ content: "found", existing_code: "x" }] },
          { toolCallId: "call-1", abortSignal: new AbortController().signal, messages: [] },
        ),
      )
      expect(collector.commentsForPath("src/a.ts")).toHaveLength(1)
    }))
})

describe("toAITool", () => {
  itEffect.effect("bridges an arbitrary Tool.Def into an AI-SDK tool", () =>
    Effect.gen(function* () {
      const collector = new ReviewCollectorImpl()
      const info = yield* codeComment(collector, "x.ts")
      const def = yield* Tool.init(info)
      const bridge = yield* EffectBridge.make()
      const ai = toAITool(
        def,
        {
          sessionID: "ses-s",
          messageID: "msg-m",
          agent: "review",
          abort: new AbortController().signal,
          messages: [],
        } as ReviewToolContext,
        bridge,
      )
      expect(ai.description).toContain("code issue")
      expect(ai.inputSchema).toBeDefined()
    }))
})
