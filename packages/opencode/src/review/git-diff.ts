// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/{parser.go,git.go} of the open-code-review project.
// The git-backed loader uses the v1 Git service (Git.Service.run) instead of
// spawning git subprocesses directly.

import { Effect } from "effect"
import { minimatch } from "minimatch"
import type { Git } from "@/git"
import type { DiffMode, ReviewDiff } from "./types"
import * as fs from "node:fs/promises"

/** Number of context lines around each changed hunk. */
export const DIFF_CONTEXT_LINES = 3

/**
 * Directory prefixes to always exclude from diff results. These are an
 * unconditional blocklist: a `.gitignore` negation cannot re-admit them.
 */
export const providerDirIgnoreDirs = [
  ".idea/",
  ".vscode/",
  ".svn/",
  ".git/",
  "vendor/",
  "node_modules/",
  "target/",
  ".happypack/",
  ".cachefile/",
  "_packages/",
  "rpm/",
  "pkgs/",
] as const

const diffHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/
// Anchored: git emits the marker at column 0 ("Binary files a/x and b/y
// differ"). Content lines inside hunks always carry a leading "+", "-" or " "
// prefix, so an anchored match can never misfire on file content.
const binaryRe = /^Binary files /

/**
 * ParseDiffText splits unified diff text into per-file Diff structs.
 *
 * Pure parser: it does not read file contents (newFileContent stays empty);
 * the git-backed loader populates content afterwards. This keeps the parser
 * fully synchronous and unit-testable.
 */
export function parseDiffText(diffText: string): ReviewDiff[] {
  const lines = diffText.split("\n")
  const diffs: ReviewDiff[] = []
  let current: ReviewDiff | undefined
  let buf: string[] = []
  // inHunk tracks whether the current line sits inside a "@@" hunk of the
  // current file's section. Only hunk content lines carry a leading "+"/"-"/" "
  // marker, so insertion/deletion counting and the binary marker must look at
  // hunk state: outside a hunk, "+++ b/file" and "--- a/file" are headers, not
  // content; inside a hunk, an added line like "++i" renders as "+++i" and
  // still counts as an insertion.
  let inHunk = false

  const flush = () => {
    if (!current) return
    current.diff = buf.join("\n").replace(/\n$/, "")
    if (current.isDeleted || current.newPath === "/dev/null") {
      current.newPath = "/dev/null"
    }
    diffs.push(current)
    current = undefined
    buf = []
  }

  for (const line of lines) {
    const m = diffHeaderRe.exec(line)
    if (m) {
      // Flush previous diff
      flush()
      current = {
        oldPath: m[1],
        newPath: m[2],
        diff: "",
        newFileContent: "",
        isBinary: false,
        isDeleted: false,
        isNew: false,
        isRenamed: false,
        insertions: 0,
        deletions: 0,
      }
      inHunk = false
    }
    if (!current) continue

    if (line.startsWith("@@")) {
      inHunk = true
    } else if (!inHunk && line.startsWith("index ")) {
      // The object IDs and mode in Git's extended "index" header are not
      // useful review context. Keep index text in hunks, where it is file
      // content and therefore carries a diff prefix.
      continue
    } else if (!inHunk && binaryRe.test(line)) {
      current.isBinary = true
    } else if (line.startsWith("new file mode ")) {
      current.isNew = true
    } else if (line.startsWith("deleted file mode ")) {
      current.isDeleted = true
    } else if (line.startsWith("rename from ")) {
      // Authoritative old path for renames; more reliable than the "diff --git"
      // header when paths contain spaces.
      current.oldPath = line.slice("rename from ".length)
      current.isRenamed = true
    } else if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length)
      current.isRenamed = true
    } else if (!inHunk && line === "--- /dev/null") {
      current.isNew = true
    } else if (!inHunk && line === "+++ /dev/null") {
      current.isDeleted = true
    } else if (inHunk && line.startsWith("+")) {
      current.insertions++
    } else if (inHunk && line.startsWith("-")) {
      current.deletions++
    }
    buf.push(line)
  }

  // Flush last diff
  flush()

  return diffs
}

/** Effective review path of a diff (new path, or old path for deletions). */
export function effectivePath(d: ReviewDiff): string {
  return d.newPath === "/dev/null" ? d.oldPath : d.newPath
}

export interface LoadDiffsInput {
  readonly cwd: string
  readonly mode: DiffMode
  /** Range mode: from/to refs. */
  readonly from?: string
  readonly to?: string
  /** Commit mode: single commit hash/ref. */
  readonly commit?: string
  /** Read new-file content for workspace mode. Defaults to node fs read. */
  readonly readFile?: (path: string) => Effect.Effect<string, unknown>
  /** The reference to read new-file content at for commit/range modes. */
  readonly ref?: string
}

const defaultReadFile = (root: string) => (path: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise(() => fs.readFile(joinPath(root, path), "utf8"))

function joinPath(root: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path
  return `${root.replace(/[\\/]$/, "")}/${path}`
}

/**
 * LoadDiffs retrieves and parses git diffs from a repository, mirroring the
 * three input modes of OCR's diff.Provider:
 *   - workspace: `git diff HEAD` (falling back to `--staged`) + synthesized
 *     untracked-file diffs.
 *   - commit: `git show --diff-merges=first-parent <commit>`.
 *   - range: `git diff <merge-base> <to>`.
 *
 * Gitignore-based path exclusion (providerDirIgnoreDirs + repo `.gitignore`)
 * is applied to tracked and untracked files alike.
 */
export function loadDiffs(git: Git.Interface, input: LoadDiffsInput): Effect.Effect<ReviewDiff[], Error> {
  return Effect.gen(function* () {
    const combined: string[] = []

    switch (input.mode) {
      case "range": {
        if (!input.from || !input.to) {
          return yield* Effect.fail(new Error("review: range mode requires from and to"))
        }
        const base = yield* git.mergeBase(input.cwd, input.from, input.to)
        if (!base) {
          return yield* Effect.fail(
            new Error(`review: cannot find merge-base between ${input.from} and ${input.to}`),
          )
        }
        const out = yield* git.run(
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--no-color",
            `-U${DIFF_CONTEXT_LINES}`,
            "--end-of-options",
            base,
            input.to,
            "--",
          ],
          { cwd: input.cwd },
        )
        if (out.exitCode !== 0) {
          return yield* Effect.fail(new Error(`review: git diff failed: ${out.stderr.toString()}`))
        }
        combined.push(out.text())
        break
      }
      case "commit": {
        if (!input.commit) {
          return yield* Effect.fail(new Error("review: commit mode requires commit"))
        }
        // --diff-merges=first-parent: for merge commits, plain `git show`
        // emits a combined diff ("diff --cc"), which parseDiffText cannot
        // parse — the commit would silently yield zero reviewable diffs.
        const out = yield* git.run(
          [
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--no-color",
            "--diff-merges=first-parent",
            `-U${DIFF_CONTEXT_LINES}`,
            "--end-of-options",
            input.commit,
          ],
          { cwd: input.cwd },
        )
        if (out.exitCode !== 0) {
          return yield* Effect.fail(new Error(`review: git show failed: ${out.stderr.toString()}`))
        }
        combined.push(out.text())
        break
      }
      case "workspace": {
        const tracked = yield* workspaceTrackedDiff(git, input.cwd)
        if (tracked) combined.push(tracked)
        const untracked = yield* workspaceUntrackedDiffs(git, input.cwd, input.readFile ?? defaultReadFile(input.cwd))
        for (const ud of untracked) {
          combined.push(ud)
          combined.push("")
          combined.push("")
        }
        break
      }
    }

    const diffs = parseDiffText(combined.join("\n"))

    // Populate new-file content for non-deleted files. Workspace mode reads
    // from disk; commit/range modes read at the resolved ref via `git show`.
    const readContent = (d: ReviewDiff): Effect.Effect<void> => {
      if (d.isDeleted || d.newPath === "/dev/null") return Effect.void
      if (input.mode === "workspace") {
        const read = input.readFile ?? defaultReadFile(input.cwd)
        return read(d.newPath).pipe(
          Effect.map((content) => {
            d.newFileContent = content
          }),
          Effect.catch(() => Effect.void),
        )
      }
      const ref = input.ref ?? (input.mode === "commit" ? input.commit : input.to)
      if (!ref) return Effect.void
      return git.show(input.cwd, ref, d.newPath).pipe(
        Effect.map((content) => {
          d.newFileContent = content
        }),
        Effect.catch(() => Effect.void),
      )
    }

    for (const d of diffs) {
      yield* readContent(d)
    }

    return diffs
  })
}

function workspaceTrackedDiff(git: Git.Interface, cwd: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    const base = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-color",
      `-U${DIFF_CONTEXT_LINES}`,
    ]
    const head = yield* git.run([...base, "--end-of-options", "HEAD", "--"], { cwd })
    if (head.exitCode === 0 && head.text() !== "") return head.text()
    // Fall back to the staged diff when `git diff HEAD` errored or was empty.
    // In a repository with no commits yet there is no HEAD, so `git diff HEAD`
    // fails, but `git diff --staged` still surfaces staged changes by diffing
    // the index against the empty tree — the only way to review a workspace
    // before its first commit.
    const staged = yield* git.run([...base, "--staged", "--"], { cwd })
    return staged.exitCode === 0 ? staged.text() : ""
  })
}

function workspaceUntrackedDiffs(
  git: Git.Interface,
  cwd: string,
  readFile: (path: string) => Effect.Effect<string, unknown>,
): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const out = yield* git.run(["ls-files", "--others", "--exclude-standard"], { cwd })
    if (out.exitCode !== 0 || out.text() === "") return []
    const patterns = yield* loadGitignorePatterns(cwd)
    const results: string[] = []
    for (const raw of out.text().split("\n")) {
      const file = raw.trim()
      if (file === "") continue
      if (isPathExcluded(file, patterns)) continue
      const content = yield* readFile(file).pipe(Effect.catch(() => Effect.succeed("")))
      results.push(synthesizeUntrackedDiff(file, content))
    }
    return results
  })
}

/** Builds a unified diff for an untracked file: all lines are additions. */
export function synthesizeUntrackedDiff(file: string, content: string): string {
  const lineCount = countLines(content)
  const lines = content.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const out = [`diff --git a/${file} b/${file}`, "--- /dev/null", `+++ b/${file}`, `@@ -0,0 +1,${lineCount} @@`]
  for (const line of lines) out.push(`+${line}`)
  return out.join("\n")
}

function countLines(content: string): number {
  let n = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++
  }
  if (content.length > 0 && content[content.length - 1] !== "\n") n++
  return n
}

// ---------------------------------------------------------------------------
// Gitignore resolution (ported from diff/git.go)
// ---------------------------------------------------------------------------

function loadGitignorePatterns(root: string): Effect.Effect<string[]> {
  return Effect.tryPromise(() => fs.readFile(`${root}/.gitignore`, "utf8")).pipe(
    Effect.map((data) => {
      const patterns: string[] = []
      for (const line of data.split("\n")) {
        const trimmed = line.trim()
        if (trimmed === "" || trimmed.startsWith("#")) continue
        patterns.push(trimmed)
      }
      return patterns
    }),
    Effect.catch(() => Effect.succeed([])),
  )
}

/**
 * isPathExcluded returns true when the given relative file path should be
 * skipped based on hardcoded dir rules or .gitignore patterns.
 *
 * Patterns are resolved the way git resolves them: in file order, with the LAST
 * matching pattern deciding, and a leading "!" inverting that pattern's verdict.
 */
export function isPathExcluded(relPath: string, gitignorePatterns: string[]): boolean {
  // Hardcoded directory prefix checks. These are an unconditional blocklist.
  for (const prefix of providerDirIgnoreDirs) {
    const dirPart = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix
    if (relPath === dirPart || relPath.startsWith(prefix)) return true
  }

  let excluded = false
  for (const pat of gitignorePatterns) {
    let body = pat
    let negated = false
    if (body.startsWith("!")) {
      body = body.slice(1)
      negated = true
    }
    if (body === "") continue

    // Directory-only patterns (trailing "/") apply to directories, never to
    // files. A negated one such as `!*/` keeps descending into subdirectories,
    // not re-admitting the files inside them.
    if (negated && body.endsWith("/")) continue

    if (matchGitignoreBody(relPath, body)) {
      excluded = !negated
    }
  }
  return excluded
}

/**
 * matchGitignoreBody reports whether relPath matches a single pattern body —
 * the pattern with any leading "!" already stripped.
 */
export function matchGitignoreBody(relPath: string, body: string): boolean {
  // Directory-only patterns (trailing /): only a real directory component can
  // match, so the final segment (the file's own name) is excluded from
  // consideration: `vendor/` must not match a *file* named "vendor".
  if (body.endsWith("/")) {
    const before = body.slice(0, -1)
    const segments = relPath.split("/")
    return segments.slice(0, -1).includes(before)
  }

  // A leading "/" anchors the pattern to the repository root rather than
  // making it a path pattern; "/.golangci.yml" addresses the root file.
  let anchored = false
  if (body.startsWith("/")) {
    body = body.slice(1)
    anchored = true
  }

  // Patterns without / match basename — unless anchored, where the pattern
  // addresses that name at the root only.
  if (!body.includes("/")) {
    const target = anchored ? relPath : relPath.split("/").pop() ?? relPath
    return minimatch(target, body, { dot: true })
  }

  // Patterns with / match against the full relative path.
  if (minimatch(relPath, body, { dot: true })) return true
  // Also try matching against a suffix of the path, but not for anchored
  // patterns: "/docs/api.md" names one file, not any path ending that way.
  if (!anchored && relPath.endsWith(`/${body}`)) return true

  return false
}
