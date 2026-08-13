// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Native review command helpers. The `review` command is wired into
// SessionPrompt.command (see session/prompt.ts): it parses the command's
// arguments into a review scope, runs the ReviewSession engine, and renders
// the collected comments so they both (a) feed a model summary turn and (b)
// reach the app as structured part metadata for the review tab.

import type { ReviewComment } from "@/review/types"

/**
 * Metadata key under which the structured review result is attached to a
 * synthetic text part. The app reads this from the synced message parts
 * (packages/app/src/pages/session.tsx) to overlay AI comments on the review
 * tab as read-only LineComments.
 */
export const REVIEW_METADATA_KEY = "newhorseReview"

export interface ReviewScope {
  readonly mode: "workspace" | "commit" | "range"
  readonly commit?: string
  readonly from?: string
  readonly to?: string
}

/**
 * Parses the review command arguments into a diff scope. Mirrors the command
 * template's contract ("review changes [commit|branch], defaults to
 * uncommitted") without the PR path, which the native engine does not support:
 *   - (empty)              -> workspace (uncommitted changes)
 *   - commit <sha>         -> commit mode
 *   - <sha>/<ref>          -> commit mode
 *   - branch <name>        -> range mode (merge-base(name, HEAD)..HEAD)
 */
export function parseReviewArguments(args: string): ReviewScope {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const [first, second] = tokens
  if (!first) return { mode: "workspace" }
  if (first === "commit") return second ? { mode: "commit", commit: second } : { mode: "workspace" }
  if (first === "branch") return second ? { mode: "range", from: second, to: "HEAD" } : { mode: "workspace" }
  return { mode: "commit", commit: first }
}

const SEVERITY_LABELS: Record<string, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
}

/**
 * Renders the human-readable findings block that becomes the review command's
 * user message. The model reads it to produce the summary turn; the chat
 * renders it so the user sees what the engine found.
 */
export function formatReviewFindings(comments: readonly ReviewComment[]): string {
  if (comments.length === 0) {
    return "Automated code review completed. No issues were found in the reviewed changes."
  }

  const files = new Set(comments.map((cm) => cm.path))
  const lines: string[] = [
    `Automated code review completed. Found ${comments.length} issue(s) across ${files.size} file(s):`,
    "",
  ]
  for (const cm of comments) {
    const range = cm.startLine > 0 && cm.endLine > 0 ? `${cm.startLine}-${cm.endLine}` : "? "
    const severity = cm.severity ? SEVERITY_LABELS[cm.severity] ?? cm.severity : undefined
    const prefix = severity ? `[${severity}] ` : ""
    lines.push(`- ${cm.path}:${range} ${prefix}${cm.content}`)
  }
  return lines.join("\n")
}

/**
 * Structured metadata attached to one synthetic text part per comment. The
 * part's text stays empty (renderable() skips it in the timeline), so the
 * metadata is the only payload; the app converts it to a LineComment.
 */
export function reviewCommentMetadata(comment: ReviewComment): Record<string, unknown> {
  return { [REVIEW_METADATA_KEY]: comment }
}
