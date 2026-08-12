// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/hunk.go of the open-code-review project.

/**
 * HunkLineType represents the type of a line in a diff hunk.
 */
export type HunkLineType = "context" | "added" | "deleted"

/**
 * HunkLine is a single line within a hunk. `content` is the line without the
 * leading `+`, `-` or ` ` marker.
 */
export interface HunkLine {
  readonly type: HunkLineType
  readonly content: string
}

/**
 * Hunk represents one `@@ ... @@` block in a unified diff.
 */
export interface Hunk {
  /** Starting line in the old file (1-indexed). */
  readonly oldStart: number
  /** Number of lines in the old file. */
  readonly oldCount: number
  /** Starting line in the new file (1-indexed). */
  readonly newStart: number
  /** Number of lines in the new file. */
  readonly newCount: number
  /** All lines in sequence. */
  readonly lines: HunkLine[]
}

const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * ParseHunks parses raw unified diff text for a single file into a slice of
 * Hunks. Lines before the first `@@` header (file-level headers like
 * "diff --git", "---", "+++") are ignored.
 */
export function parseHunks(rawDiffText: string): Hunk[] {
  const lines = rawDiffText.split("\n")
  const hunks: Hunk[] = []
  let current: Hunk | undefined

  for (const line of lines) {
    const m = hunkHeaderRe.exec(line)
    if (m) {
      // Flush previous hunk
      if (current) hunks.push(current)
      const oldStart = Number(m[1])
      const oldCount = m[2] !== undefined ? Number(m[2]) : 1
      const newStart = Number(m[3])
      const newCount = m[4] !== undefined ? Number(m[4]) : 1
      current = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      }
      continue
    }

    if (!current) continue // skip file-level headers and preamble

    // Skip metadata lines that can appear inside hunks
    if (line.startsWith("\\ No newline at end of file")) continue
    // Stop processing if we hit another file's diff header
    if (line.startsWith("diff --git ")) break

    if (line.startsWith("+")) {
      current.lines.push({ type: "added", content: line.slice(1) })
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "deleted", content: line.slice(1) })
    } else {
      // Context line (' ' prefix) or other — treat as context
      let content = line
      if (content.length > 0 && content[0] === " ") content = content.slice(1)
      current.lines.push({ type: "context", content })
    }
  }

  // Flush last hunk
  if (current) hunks.push(current)

  return hunks
}
