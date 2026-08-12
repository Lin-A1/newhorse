// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/resolver.go of the open-code-review project.
// LLM re-location (internal/diff/relocation.go) is deferred.

import type { Hunk } from "./hunk"
import { parseHunks } from "./hunk"
import type { ReviewComment, ReviewDiff } from "./types"

/**
 * ResolveLineNumbers populates startLine/endLine on each comment by matching
 * the existingCode against the corresponding file's diff hunks (primary), or
 * falling back to scanning the full new-file content line-by-line.
 */
export function resolveLineNumbers(comments: ReviewComment[], diffs: ReviewDiff[]): ReviewComment[] {
  if (comments.length === 0 || diffs.length === 0) return comments

  // Build lookup: newPath/oldPath -> diff
  const diffByPath = new Map<string, ReviewDiff>()
  for (const d of diffs) {
    if (d.newPath !== "/dev/null" && d.newPath !== "") diffByPath.set(d.newPath, d)
    if (d.oldPath !== "/dev/null" && d.oldPath !== "") diffByPath.set(d.oldPath, d)
  }

  const result = comments.map((cm) => ({ ...cm }))
  for (const cm of result) {
    if (cm.startLine > 0 || cm.endLine > 0) continue
    if (cm.existingCode === "") continue
    const d = diffByPath.get(cm.path)
    if (!d) continue

    // Primary: try matching from deleted/context lines in diff hunks
    if (resolveFromHunk(d, cm)) continue

    // Fallback: scan the new file content for consecutive matches
    resolveFromFileContent(d, cm)
  }

  return result
}

/**
 * ResolveComment attempts to resolve startLine/endLine for a single comment by
 * matching existingCode against the diff. Returns true on success.
 */
export function resolveComment(cm: ReviewComment, d: ReviewDiff): boolean {
  if (cm.startLine > 0 || cm.endLine > 0) return true
  if (cm.existingCode === "") return false
  if (resolveFromHunk(d, cm)) return true
  return resolveFromFileContent(d, cm)
}

/** indexedLine pairs a normalized line with its absolute file line number. */
interface IndexedLine {
  lineNum: number
  content: string
}

/**
 * resolveFromHunk tries to find startLine/endLine by matching existingCode
 * against hunk lines. It tries the new-side first (context + added lines →
 * new-file line numbers), then falls back to old-side (context + deleted →
 * old-file line numbers).
 */
function resolveFromHunk(d: ReviewDiff, cm: ReviewComment): boolean {
  const hunks = parseHunks(d.diff)
  if (hunks.length === 0) return false

  const targetLines = splitAndNormalize(cm.existingCode ?? "")
  if (targetLines.length === 0) return false

  for (const hunk of hunks) {
    const newSide = extractSideLines(hunk, true)
    const match = matchConsecutive(newSide, targetLines)
    if (match) {
      cm.startLine = match.start
      cm.endLine = match.end
      return true
    }
  }

  for (const hunk of hunks) {
    const oldSide = extractSideLines(hunk, false)
    const match = matchConsecutive(oldSide, targetLines)
    if (match) {
      cm.startLine = match.start
      cm.endLine = match.end
      return true
    }
  }

  return false
}

/**
 * extractSideLines extracts one side of the diff from a hunk. When newSide is
 * true, returns context+added lines with new-file line numbers. When newSide
 * is false, returns context+deleted lines with old-file line numbers.
 */
export function extractSideLines(hunk: Hunk, newSide: boolean): IndexedLine[] {
  const result: IndexedLine[] = []
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart

  for (const l of hunk.lines) {
    switch (l.type) {
      case "context":
        if (newSide) result.push({ lineNum: newLine, content: normalizeLine(l.content) })
        else result.push({ lineNum: oldLine, content: normalizeLine(l.content) })
        oldLine++
        newLine++
        break
      case "added":
        if (newSide) result.push({ lineNum: newLine, content: normalizeLine(l.content) })
        newLine++
        break
      case "deleted":
        if (!newSide) result.push({ lineNum: oldLine, content: normalizeLine(l.content) })
        oldLine++
        break
    }
  }
  return result
}

/**
 * matchConsecutive scans sideLines for a consecutive run matching all
 * targetLines. Returns { start, end } for the first match.
 */
export function matchConsecutive(sideLines: IndexedLine[], targetLines: string[]): { start: number; end: number } | undefined {
  if (targetLines.length === 0 || sideLines.length < targetLines.length) return undefined
  for (let i = 0; i <= sideLines.length - targetLines.length; i++) {
    let matched = true
    for (let j = 0; j < targetLines.length; j++) {
      if (sideLines[i + j]!.content !== targetLines[j]) {
        matched = false
        break
      }
    }
    if (matched) {
      return {
        start: sideLines[i]!.lineNum,
        end: sideLines[i + targetLines.length - 1]!.lineNum,
      }
    }
  }
  return undefined
}

/**
 * resolveFromFileContent scans the new file content line-by-line for
 * consecutive matches of the normalized existing_code. "Consecutive" here
 * means adjacent non-blank lines.
 */
function resolveFromFileContent(d: ReviewDiff, cm: ReviewComment): boolean {
  if (d.newFileContent === "") return false

  const fileLines = d.newFileContent.split("\n")
  const targetLines = splitAndNormalize(cm.existingCode ?? "")
  if (targetLines.length === 0) return false

  const normalizedFileLines: string[] = []
  const fileLineNums: number[] = []
  for (let i = 0; i < fileLines.length; i++) {
    const n = normalizeLine(fileLines[i]!.replace(/\r+$/, ""))
    if (n === "") continue
    normalizedFileLines.push(n)
    fileLineNums.push(i + 1)
  }

  if (normalizedFileLines.length < targetLines.length) return false

  for (let i = 0; i <= normalizedFileLines.length - targetLines.length; i++) {
    let matched = true
    for (let j = 0; j < targetLines.length; j++) {
      if (normalizedFileLines[i + j] !== targetLines[j]) {
        matched = false
        break
      }
    }
    if (matched) {
      cm.startLine = fileLineNums[i]!
      cm.endLine = fileLineNums[i + targetLines.length - 1]!
      return true
    }
  }

  return false
}

/**
 * splitAndNormalize splits code text into lines and normalizes each one,
 * skipping blank lines.
 */
export function splitAndNormalize(code: string): string[] {
  const raw = code.split("\n")
  const result: string[] = []
  for (const line of raw) {
    const n = normalizeLine(line)
    if (n === "") continue
    result.push(n)
  }
  return result
}

/**
 * normalizeLine removes leading/trailing whitespace and strips any leading '+'
 * or '-' diff marker.
 */
export function normalizeLine(s: string): string {
  s = s.trim()
  if (s.startsWith("+")) s = s.slice(1)
  else if (s.startsWith("-")) s = s.slice(1)
  return s.trim()
}
