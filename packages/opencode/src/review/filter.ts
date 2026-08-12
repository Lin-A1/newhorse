// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/preview.go and internal/config/allowlist of the
// open-code-review project. Deterministic, LLM-free file filtering.

import { minimatch } from "minimatch"
import { defaultExcludePatterns } from "./config/default-exclude-patterns"
import { supportedFileTypes } from "./config/supported-file-types"
import { effectivePath } from "./git-diff"
import {
  EXCLUDE_BINARY,
  EXCLUDE_DEFAULT_PATH,
  EXCLUDE_EXTENSION,
  EXCLUDE_NONE,
  EXCLUDE_USER_RULE,
  type ExcludeReason,
  type ReviewDiff,
} from "./types"

const SUPPORTED_EXTENSIONS = new Set<string>(supportedFileTypes)
const DEFAULT_EXCLUDE_PATTERNS = defaultExcludePatterns as readonly string[]

/**
 * UserFileFilter holds optional user-configured include/exclude glob patterns
 * applied before the default extension/path filters. When empty, only the
 * default filters apply.
 */
export interface UserFileFilter {
  /** Globs that restrict review to matching paths. Empty = no restriction. */
  readonly include?: string[]
  /** Globs whose matching paths are always excluded from review. */
  readonly exclude?: string[]
}

/**
 * IsAllowedExt returns true when the given file extension (with leading dot) is
 * in the supported types list. The check is case-insensitive.
 */
export function isAllowedExt(ext: string): boolean {
  return SUPPORTED_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * IsExcludedPath returns true when the given file path matches any default
 * exclude pattern. Patterns support `**`, `*` and `{a,b,c}` brace expansion.
 * The check is case-insensitive.
 */
export function isExcludedPath(path: string): boolean {
  const lower = path.toLowerCase()
  for (const pattern of DEFAULT_EXCLUDE_PATTERNS) {
    if (minimatch(lower, pattern, { dot: true })) return true
  }
  return false
}

/** File extension with leading dot, lowercased. Empty when the path has none. */
export function extFromPath(path: string): string {
  const slash = path.lastIndexOf("/")
  const basename = slash >= 0 ? path.slice(slash + 1) : path
  const dot = basename.lastIndexOf(".")
  if (dot <= 0) return ""
  return basename.slice(dot).toLowerCase()
}

function isUserExcluded(path: string, patterns: string[]): boolean {
  const lower = path.toLowerCase()
  return patterns.some((p) => minimatch(lower, p, { dot: true }))
}

function isUserIncluded(path: string, patterns: string[]): boolean {
  const lower = path.toLowerCase()
  return patterns.some((p) => minimatch(lower, p, { dot: true }))
}

/**
 * whyExcluded applies the filter algorithm as `shouldReview` but returns the
 * specific reason a file is excluded.
 */
export function whyExcluded(d: ReviewDiff, filter?: UserFileFilter): ExcludeReason {
  if (d.isBinary) return EXCLUDE_BINARY

  const path = effectivePath(d)
  const f = filter

  if (f && f.exclude && f.exclude.length > 0 && isUserExcluded(path, f.exclude)) return EXCLUDE_USER_RULE
  if (f && f.include && f.include.length > 0 && isUserIncluded(path, f.include)) return EXCLUDE_NONE

  const ext = extFromPath(path)
  if (ext !== "" && !isAllowedExt(ext)) return EXCLUDE_EXTENSION
  if (isExcludedPath(path)) return EXCLUDE_DEFAULT_PATH

  return EXCLUDE_NONE
}

/** shouldReview reports whether a diff survives all default filters. */
export function shouldReview(d: ReviewDiff, filter?: UserFileFilter): boolean {
  return whyExcluded(d, filter) === EXCLUDE_NONE
}

/** filterDiffs drops diffs that should not be reviewed. Pure deletions are NOT filtered here. */
export function filterDiffs(diffs: ReviewDiff[], filter?: UserFileFilter): ReviewDiff[] {
  return diffs.filter((d) => shouldReview(d, filter))
}

/**
 * promptTokenLimit returns 80% of maxTokens — the threshold above which a
 * single file's diff content is considered too large to review.
 */
export function promptTokenLimit(maxTokens: number): number {
  return Math.floor(maxTokens * 0.8)
}

/**
 * estimateTokens is a cheap token estimate (bytes / 4), matching OCR's
 * fallback tokenizer path.
 */
export function estimateTokens(text: string): number {
  if (text === "") return 0
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4)
}

/**
 * filterLargeDiffs drops diffs whose diff content alone consumes more than 80%
 * of maxTokens. A non-positive maxTokens disables the threshold.
 */
export function filterLargeDiffs(diffs: ReviewDiff[], maxTokens: number): ReviewDiff[] {
  const limit = promptTokenLimit(maxTokens)
  if (limit <= 0) return diffs
  return diffs.filter((d) => estimateTokens(d.diff) <= limit)
}

/** diffStatus renders a short status label for a diff. */
export function diffStatus(d: ReviewDiff): string {
  if (d.isBinary) return "binary"
  if (d.isNew) return "added"
  if (d.isDeleted) return "deleted"
  if (d.isRenamed) return "renamed"
  if (d.oldPath !== d.newPath && d.oldPath !== "" && d.oldPath !== "/dev/null") return "renamed"
  return "modified"
}
