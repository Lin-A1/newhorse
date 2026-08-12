// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/comment_collector.go of the open-code-review project.

import type { ReviewComment } from "./types"

/**
 * ReviewCollector is the per-review comment store. All mutations are
 * synchronous, so they are safe against interleaved AI-SDK tool execution.
 */
export interface ReviewCollector {
  /** Append a comment to the collector. */
  add(comment: ReviewComment): void
  /** Return a copy of all collected comments. */
  comments(): ReviewComment[]
  /** Return a copy of comments whose path matches. */
  commentsForPath(path: string): ReviewComment[]
  /**
   * Remove comments for a given path whose per-path index (0-based position
   * among all comments with that path) is in the indices set.
   */
  removeByPathAndIndices(path: string, indices: ReadonlySet<number>): void
}

export class ReviewCollectorImpl implements ReviewCollector {
  private commentsList: ReviewComment[] = []

  add(comment: ReviewComment): void {
    this.commentsList.push(comment)
  }

  comments(): ReviewComment[] {
    return [...this.commentsList]
  }

  commentsForPath(path: string): ReviewComment[] {
    return this.commentsList.filter((cm) => cm.path === path)
  }

  removeByPathAndIndices(path: string, indices: ReadonlySet<number>): void {
    const kept: ReviewComment[] = []
    let pathIdx = 0
    for (const cm of this.commentsList) {
      if (cm.path === path) {
        if (indices.has(pathIdx)) {
          pathIdx++
          continue
        }
        pathIdx++
      }
      kept.push(cm)
    }
    this.commentsList = kept
  }
}
