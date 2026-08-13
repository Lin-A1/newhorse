// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Native code-review session for the v1 runtime, modeled on the
// open-code-review project's internal/agent pipeline (Apache-2.0). Each
// reviewable file runs one restricted AI-SDK tool session (read/glob/grep +
// code_comment/task_done/file_read_diff) through LLM.Service.stream; the AI
// SDK auto-executes tool calls across multiple rounds. Comments land in a
// shared collector, get line numbers resolved, then pass through the
// falsify-not-verify review filter.

import { Effect, Layer, Context } from "effect"
import * as Stream from "effect/Stream"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { LLMEvent } from "@newhorse/llm"
import { SessionV1 } from "@newhorse/core/v1/session"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { LLM } from "@/session/llm"
import { Git } from "@/git"
import { FSUtil } from "@newhorse/core/fs-util"
import { Ripgrep } from "@newhorse/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Truncate } from "@/tool/truncate"
import * as Tool from "@/tool/tool"
import { ReadTool } from "@/tool/read"
import { GrepTool } from "@/tool/grep"
import { GlobTool } from "@/tool/glob"
import { MessageID } from "@/session/schema"
import { loadDiffs, effectivePath } from "./git-diff"
import { filterDiffs, filterLargeDiffs, type UserFileFilter } from "./filter"
import { ReviewCollectorImpl, type ReviewCollector } from "./collector"
import { buildReviewTools, type ReviewToolContext } from "./tools"
import { resolveComment } from "./position"
import { buildFilterCommentsJSON, parseFilterResponse } from "./filter-comments"
import type { DiffMode, ReviewComment, ReviewDiff } from "./types"

import mainTaskSystem from "./templates/main_task_system.txt"
import mainTaskUser from "./templates/main_task_user.txt"
import reviewFilterSystem from "./templates/review_filter_task_system.txt"
import reviewFilterUser from "./templates/review_filter_task_user.txt"

export interface ReviewSessionInput {
  readonly cwd: string
  readonly mode: DiffMode
  /** Range mode: from/to refs. */
  readonly from?: string
  readonly to?: string
  /** Commit mode: single commit hash/ref. */
  readonly commit?: string
  readonly sessionID: string
  readonly user: SessionV1.User
  readonly agent: Agent.Info
  readonly model: Provider.Model
  readonly permission?: PermissionV1.Ruleset
  /** maxTokens for the >80% size gate. 0 disables the threshold. */
  readonly maxTokens?: number
  /** Requirement/business context injected into {{requirement_background}}. */
  readonly background?: string
  /** Optional user include/exclude glob patterns. */
  readonly fileFilter?: UserFileFilter
}

export interface Interface {
  readonly run: (input: ReviewSessionInput) => Effect.Effect<ReviewComment[], Error>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/ReviewSession") {}

// ---------------------------------------------------------------------------
// Pure, unit-testable prompt rendering
// ---------------------------------------------------------------------------

/** Formats a Date as `YYYY-MM-DD HH:MM` (OCR's "2006-01-02 15:04" layout). */
export function formatCurrentDateTime(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Renders the "other changed files" list, excluding the current file. */
export function buildChangeFilesExcept(diffs: ReviewDiff[], excludePath: string): string {
  const lines: string[] = []
  for (const d of diffs) {
    if (d.isBinary) continue
    if (d.newPath === excludePath || d.oldPath === excludePath) continue
    let status = "MODIFIED"
    if (d.isNew) status = "ADDED"
    else if (d.isDeleted) status = "DELETED"
    else if (d.oldPath !== d.newPath) status = "RENAMED"
    lines.push(`${status}   ${effectivePath(d)}`)
  }
  return lines.join("\n")
}

export interface RenderMainTaskUserInput {
  readonly changeFiles: string
  readonly filePath: string
  readonly diff: string
  readonly currentDateTime: string
  readonly background?: string
}

/** Renders the main_task user prompt from the OCR template. */
export function renderMainTaskUser(input: RenderMainTaskUserInput): string {
  return mainTaskUser
    .replaceAll("{{change_files}}", input.changeFiles)
    .replaceAll("{{current_file_path}}", input.filePath)
    .replaceAll("{{diff}}", input.diff)
    .replaceAll("{{current_system_date_time}}", input.currentDateTime)
    .replaceAll("{{requirement_background}}", input.background ?? "")
    .replaceAll("{{system_rule}}", "")
    .replaceAll("{{plan_guidance}}", "")
}

export interface RenderReviewFilterUserInput {
  readonly path: string
  readonly diff: string
  readonly comments: string
}

/** Renders the review_filter user prompt from the OCR template. */
export function renderReviewFilterUser(input: RenderReviewFilterUserInput): string {
  return reviewFilterUser
    .replaceAll("{{path}}", input.path)
    .replaceAll("{{diff}}", input.diff)
    .replaceAll("{{comments}}", input.comments)
}

// ---------------------------------------------------------------------------
// Review session service
// ---------------------------------------------------------------------------

const layer = Layer.effect(
  Service,
  Effect.scoped(
    Effect.gen(function* () {
      const git = yield* Git.Service
      const llm = yield* LLM.Service
      const fs = yield* FSUtil.Service
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service

      // Init the shared context tools once at layer build (inside a scope).
      const readInfo = yield* ReadTool
      const grepInfo = yield* GrepTool
      const globInfo = yield* GlobTool
      const readDef = yield* Tool.init(readInfo)
      const grepDef = yield* Tool.init(grepInfo)
      const globDef = yield* Tool.init(globInfo)
      const contextTools = new Map<string, Tool.Def>([
        ["read", readDef],
        ["glob", globDef],
        ["grep", grepDef],
      ])

      const run = Effect.fn("ReviewSession.run")(function* (input: ReviewSessionInput) {
        // Load and filter diffs.
        const parsed = yield* loadDiffs(git, {
          cwd: input.cwd,
          mode: input.mode,
          from: input.from,
          to: input.to,
          commit: input.commit,
          readFile: (path) => fs.readFileString(path),
        })
        const all = parsed
        const filtered = filterLargeDiffs(filterDiffs(parsed, input.fileFilter), input.maxTokens ?? 0)
        if (filtered.length === 0) return []

        // Read-only diff map over ALL parsed diffs so the model can query
        // related (even filtered-out) files.
        const diffMap = new Map<string, string>()
        for (const d of all) {
          if (d.newPath !== "/dev/null") diffMap.set(d.newPath, d.diff)
        }

        const collector: ReviewCollector = new ReviewCollectorImpl()
        const currentDateTime = formatCurrentDateTime()
        const background = input.background ?? ""

        for (const d of filtered) {
          if (d.isDeleted) continue
          yield* reviewFile(d)
        }

        return collector.comments()

        function reviewFile(d: ReviewDiff) {
          const filePath = effectivePath(d)
          const userContent = renderMainTaskUser({
            changeFiles: buildChangeFilesExcept(all, filePath),
            filePath,
            diff: d.diff,
            currentDateTime,
            background,
          })

          return Effect.gen(function* () {
            const messageID = MessageID.make(`msg-review-${filePath}`)
            const toolContext: ReviewToolContext = {
              sessionID: input.sessionID,
              messageID: messageID.toString(),
              agent: input.agent.name,
              abort: new AbortController().signal,
              messages: [],
              extra: { review: true },
            }

            const tools = yield* buildReviewTools({
              collector,
              filePath,
              diffMap,
              onTaskDone: () => {},
              context: toolContext,
              existing: contextTools,
            })

            yield* llm
              .stream({
                user: input.user,
                sessionID: input.sessionID,
                model: input.model,
                agent: input.agent,
                permission: input.permission,
                system: [mainTaskSystem],
                messages: [{ role: "user", content: userContent }],
                tools,
              })
              .pipe(
                Stream.tap((event) => {
                  if (LLMEvent.is.providerError(event)) {
                    return Effect.logError("review stream provider error", {
                      "review.file": filePath,
                      message: event.message,
                    })
                  }
                  if (LLMEvent.is.finish(event) && event.reason === "error") {
                    return Effect.logError("review stream finished with error", { "review.file": filePath })
                  }
                  return Effect.void
                }),
                Stream.runDrain,
              )
              .pipe(Effect.catch((error) => Effect.logError("review file failed", { "review.file": filePath, error })))

            // Resolve line numbers on the collector's comments in place.
            for (const cm of collector.commentsForPath(filePath)) {
              resolveComment(cm, d)
            }

            yield* runReviewFilter(d, filePath, collector)
          })
        }

        function runReviewFilter(d: ReviewDiff, filePath: string, c: ReviewCollector) {
          const comments = c.commentsForPath(filePath)
          if (comments.length === 0) return Effect.void

          const userContent = renderReviewFilterUser({
            path: filePath,
            diff: d.diff,
            comments: buildFilterCommentsJSON(comments),
          })

          return Effect.gen(function* () {
            const text = yield* llm
              .stream({
                user: input.user,
                sessionID: input.sessionID,
                model: input.model,
                agent: input.agent,
                permission: input.permission,
                system: [reviewFilterSystem],
                messages: [{ role: "user", content: userContent }],
                tools: {},
              })
              .pipe(
                Stream.filter(LLMEvent.is.textDelta),
                Stream.map((e) => e.text),
                Stream.mkString,
                Effect.orDie,
              )
              .pipe(Effect.catch(() => Effect.succeed("")))

            const indices = parseFilterResponse(text, comments.length)
            if (indices && indices.size > 0) {
              c.removeByPathAndIndices(filePath, indices)
            }
          })
        }
      })

      return Service.of({
        run: (input) =>
          run(input).pipe(
            Effect.provideService(Truncate.Service, truncate),
            Effect.provideService(Agent.Service, agents),
            Effect.scoped,
          ),
      })
    }),
  ),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Git.node,
    LLM.node,
    FSUtil.node,
    Ripgrep.node,
    LSP.node,
    Instruction.node,
    Truncate.node,
    Agent.node,
  ],
})

export * as ReviewSession from "./runner"
