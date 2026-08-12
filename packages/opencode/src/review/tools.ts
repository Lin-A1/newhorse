// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/{code_comment,file_read_diff}.go and the tool
// JSON schemas in internal/config/toolsconfig/tools.json of the
// open-code-review project. The three review-only tools are built with the v1
// `Tool.define` primitive and exposed as AI-SDK tools for a restricted
// `LLM.Service.stream` session.

import { Effect, Schema } from "effect"
import { jsonSchema, tool as aiTool, type Tool as AITool, type ToolExecutionOptions } from "ai"
import type { SessionV1 } from "@newhorse/core/v1/session"
import * as Tool from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { EffectBridge } from "@/effect/bridge"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import type { ReviewCollector } from "./collector"
import type { ReviewComment } from "./types"

export const COMMENT_SUCCEED = "Successfully commented."

// ---------------------------------------------------------------------------
// Tool schemas (mirroring internal/config/toolsconfig/tools.json)
// ---------------------------------------------------------------------------

const codeCommentCategories = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
] as const

const codeCommentSeverities = ["critical", "high", "medium", "low"] as const

export const CodeCommentParameters = Schema.Struct({
  comments: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      existing_code: Schema.optional(Schema.String),
      suggestion_code: Schema.optional(Schema.String),
      thinking: Schema.optional(Schema.String),
      category: Schema.optional(Schema.Literals(codeCommentCategories)),
      severity: Schema.optional(Schema.Literals(codeCommentSeverities)),
    }),
  ),
})
export type CodeCommentArgs = Schema.Schema.Type<typeof CodeCommentParameters>

export const TaskDoneParameters = Schema.Struct({
  state: Schema.optional(Schema.Literals(["DONE", "FAILED"])),
})
export type TaskDoneArgs = Schema.Schema.Type<typeof TaskDoneParameters>

export const FileReadDiffParameters = Schema.Struct({
  path_array: Schema.Array(Schema.String),
})
export type FileReadDiffArgs = Schema.Schema.Type<typeof FileReadDiffParameters>

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

const CODE_COMMENT_DESCRIPTION = `When you discover that a code change could introduce code issue, please use this tool to report the issue. The tool will pinpoint your feedback to the precise code line (or block) in the current file by inserting a code comment.

**Core Mechanism:**
This tool uses a dynamic sliding window algorithm to match corresponding consecutive lines in diff text based on your provided 'existing_code' parameter. Therefore, you must ensure the provided 'existing_code' actually exists in the diff text with exactly matching format. It should contain one or several consecutive lines of code most relevant to your comment.`

const FILE_READ_DIFF_DESCRIPTION = `The tool is used to view the changes made to other files in the list of modifications. Call this tool when you discover suspected code issues but need to check changes in other files to confirm whether the problem actually exists. This tool will respond in git diff format.

Output example:
==== FILE: path/to/file1.txt ====
--- a/path/to/file1.txt
+++ b/path/to/file1.txt
@@ -10,1 +10,1 @@
- old content
+ new content

==== FILE: path/to/file2.txt ====
@@ -5,1 +5,2 @@
  - old content
  + new content1
  + new content2`

const TASK_DONE_DESCRIPTION = `Call this tool to terminate task execution when you have completed the user's task, such as when no obvious code issues are found during code review.`

/**
 * codeCommentArgsToComments converts a decoded code_comment payload into
 * ReviewComment entries with the current file path injected (the engine always
 * overrides the path — the model must not supply one).
 */
export function codeCommentArgsToComments(args: CodeCommentArgs, path: string): ReviewComment[] {
  const comments: ReviewComment[] = []
  for (const c of args.comments) {
    if (!c.content) continue
    comments.push({
      path,
      content: c.content,
      suggestionCode: c.suggestion_code,
      existingCode: c.existing_code,
      thinking: c.thinking,
      category: c.category ?? "other",
      severity: c.severity ?? "low",
      startLine: 0,
      endLine: 0,
    })
  }
  return comments
}

/**
 * formatFileReadDiff renders the diff text for the requested paths. Returns
 * the OCR "not found" message when none of the paths resolve.
 */
export function formatFileReadDiff(diffMap: ReadonlyMap<string, string>, pathArray: readonly string[]): string {
  const parts: string[] = []
  for (const path of pathArray) {
    const d = diffMap.get(path)
    if (d === undefined) continue
    parts.push(`==== FILE: ${path} ====`)
    parts.push(d)
    parts.push("")
  }
  const result = parts.join("\n").replace(/\n+$/, "")
  if (result === "") return "Error: diff not found for the requested paths"
  return result
}

/**
 * taskDoneResult resolves the task_done outcome from its state argument.
 * Returns { failed, output } matching OCR's TaskCheckpoint semantics.
 */
export function taskDoneResult(state: TaskDoneArgs["state"]): { failed: boolean; output: string } {
  if (state === "FAILED") return { failed: true, output: "task_done reported FAILED" }
  return { failed: false, output: "Task complete." }
}

// ---------------------------------------------------------------------------
// Tool definitions (v1 Tool.define)
// ---------------------------------------------------------------------------

/**
 * codeComment builds the code_comment tool for a single file review. The
 * current file path is injected into every comment added to the collector.
 */
export function codeComment(collector: ReviewCollector, filePath: string) {
  return Tool.define(
    "code_comment",
    Effect.succeed({
      description: CODE_COMMENT_DESCRIPTION,
      parameters: CodeCommentParameters,
      execute: (args: CodeCommentArgs): Effect.Effect<Tool.ExecuteResult> =>
        Effect.sync(() => {
          for (const cm of codeCommentArgsToComments(args, filePath)) {
            collector.add(cm)
          }
          return {
            title: "code_comment",
            metadata: { count: args.comments.length, path: filePath },
            output: COMMENT_SUCCEED,
          } satisfies Tool.ExecuteResult
        }),
    }),
  )
}

/**
 * taskDone builds the task_done tool. `onDone` is invoked with the resolved
 * state so the caller can stop the review loop.
 */
export function taskDone(onDone: (state: "DONE" | "FAILED") => void) {
  return Tool.define(
    "task_done",
    Effect.succeed({
      description: TASK_DONE_DESCRIPTION,
      parameters: TaskDoneParameters,
      execute: (args: TaskDoneArgs): Effect.Effect<Tool.ExecuteResult> =>
        Effect.sync(() => {
          const state = args.state ?? "DONE"
          const { failed, output } = taskDoneResult(state)
          onDone(state)
          return {
            title: "task_done",
            metadata: { state, failed },
            output,
          } satisfies Tool.ExecuteResult
        }),
    }),
  )
}

/**
 * fileReadDiff builds the file_read_diff tool, which looks up a file's diff
 * text from the pre-loaded diff map by path.
 */
export function fileReadDiff(diffMap: ReadonlyMap<string, string>) {
  return Tool.define(
    "file_read_diff",
    Effect.succeed({
      description: FILE_READ_DIFF_DESCRIPTION,
      parameters: FileReadDiffParameters,
      execute: (args: FileReadDiffArgs): Effect.Effect<Tool.ExecuteResult> =>
        Effect.sync(() => {
          const output = formatFileReadDiff(diffMap, args.path_array)
          return {
            title: "file_read_diff",
            metadata: { count: args.path_array.length },
            output,
          } satisfies Tool.ExecuteResult
        }),
    }),
  )
}

// ---------------------------------------------------------------------------
// AI-SDK tool assembly
// ---------------------------------------------------------------------------

/** Base context shared by every tool in a restricted review session. */
export interface ReviewToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  readonly abort: AbortSignal
  readonly messages: SessionV1.WithParts[]
  readonly extra?: { [key: string]: unknown }
}

function reviewContext(base: ReviewToolContext, options: ToolExecutionOptions): Tool.Context {
  return {
    sessionID: SessionID.make(base.sessionID),
    messageID: MessageID.make(base.messageID),
    agent: base.agent,
    abort: options.abortSignal ?? base.abort,
    callID: options.toolCallId,
    extra: base.extra,
    messages: base.messages,
    // The review session owns its tool outputs; no per-tool metadata or
    // permission prompts are surfaced to a processor.
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

/**
 * toAITool adapts a v1 Tool.Def into an AI-SDK tool for `LLM.Service.stream`.
 * Execution is bridged back into Effect, preserving the workspace/instance
 * context captured by the review session.
 */
export function toAITool(def: Tool.Def, base: ReviewToolContext, bridge: EffectBridge.Shape): AITool {
  const schema = ToolJsonSchema.fromTool(def)
  return aiTool({
    description: def.description,
    inputSchema: jsonSchema(schema),
    execute(args, options) {
      return bridge.promise(
        Effect.gen(function* () {
          const result = yield* def.execute(args as never, reviewContext(base, options))
          return result
        }),
      )
    },
  })
}

export interface BuildReviewToolsInput {
  readonly collector: ReviewCollector
  readonly filePath: string
  readonly diffMap: ReadonlyMap<string, string>
  readonly onTaskDone: (state: "DONE" | "FAILED") => void
  readonly context: ReviewToolContext
  /** Pre-initialized context tools (read/glob/grep Defs) to include. */
  readonly existing: ReadonlyMap<string, Tool.Def>
}

/**
 * buildReviewTools assembles the restricted tool set for one file's review
 * session: the three review-only tools plus the caller's context tools.
 */
export function buildReviewTools(
  input: BuildReviewToolsInput,
): Effect.Effect<Record<string, AITool>, never, Truncate.Service | Agent.Service> {
  return Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()
    const codeCommentDef = yield* Tool.init(yield* codeComment(input.collector, input.filePath))
    const taskDoneDef = yield* Tool.init(yield* taskDone(input.onTaskDone))
    const fileReadDiffDef = yield* Tool.init(yield* fileReadDiff(input.diffMap))

    const tools: Record<string, AITool> = {}
    for (const [id, def] of input.existing) {
      tools[id] = toAITool(def, input.context, bridge)
    }
    tools["code_comment"] = toAITool(codeCommentDef, input.context, bridge)
    tools["task_done"] = toAITool(taskDoneDef, input.context, bridge)
    tools["file_read_diff"] = toAITool(fileReadDiffDef, input.context, bridge)
    return tools
  })
}
