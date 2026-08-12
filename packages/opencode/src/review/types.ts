// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Shared model types for the native code-review engine, ported from
// internal/model/{diff.go,review.go} of the open-code-review project.

/**
 * Mode defines how the diff is retrieved.
 * - workspace: current workspace (staged + unstaged + untracked)
 * - commit: single commit vs its first parent
 * - range: merge-base(from,to)..to
 */
export type DiffMode = "workspace" | "commit" | "range"

/**
 * Diff represents a single file change in a git diff.
 *
 * Note: fields are intentionally mutable — the diff parser assembles objects
 * incrementally before exposing them to consumers.
 */
export interface ReviewDiff {
  oldPath: string
  newPath: string
  diff: string
  newFileContent: string
  isBinary: boolean
  isDeleted: boolean
  isNew: boolean
  isRenamed: boolean
  insertions: number
  deletions: number
}

/**
 * Why a file was excluded from review. Mirrors the `ExcludeReason` type of
 * internal/model/preview.go.
 */
export type ExcludeReason = "none" | "user-rule" | "extension" | "default-path" | "deleted" | "binary"

/**
 * ReviewComment is a single review finding. Line numbers are 0 when they have
 * not been resolved yet; they are the mutable resolution targets filled in by
 * the line-position resolver.
 */
export interface ReviewComment {
  readonly path: string
  readonly content: string
  readonly suggestionCode?: string
  readonly existingCode?: string
  startLine: number
  endLine: number
  readonly thinking?: string
  /** One of: bug, security, performance, maintainability, test, style, documentation, other. */
  readonly category?: string
  /** One of: critical, high, medium, low. */
  readonly severity?: string
}

export const EXCLUDE_NONE: ExcludeReason = "none"
export const EXCLUDE_USER_RULE: ExcludeReason = "user-rule"
export const EXCLUDE_EXTENSION: ExcludeReason = "extension"
export const EXCLUDE_DEFAULT_PATH: ExcludeReason = "default-path"
export const EXCLUDE_DELETED: ExcludeReason = "deleted"
export const EXCLUDE_BINARY: ExcludeReason = "binary"
