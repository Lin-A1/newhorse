import path from "path"
import { fileURLToPath } from "url"
import { Effect } from "effect"
import { FSUtil } from "@newhorse/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { LSP } from "@/lsp/lsp"
import type * as Tool from "./tool"

// ---------------------------------------------------------------------------
// LSP result shapes (subset of the LSP spec the split tools consume).
// The LSP.Service returns `any[]`, so these are structural types used by the
// formatting / workspace-edit helpers, not validated schemas.
// ---------------------------------------------------------------------------

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Location {
  uri: string
  range: Range
}

export interface LocationLink {
  targetUri: string
  targetRange: Range
  targetSelectionRange: Range
}

export interface SymbolInfo {
  name: string
  kind: number
  location: Location
  containerName?: string
}

export interface DocumentSymbol {
  name: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
}

export interface Diagnostic {
  range: Range
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export interface TextEdit {
  range: Range
  newText: string
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version: number | null }
  edits: TextEdit[]
}

export interface CreateFile {
  kind: "create"
  uri: string
}

export interface RenameFile {
  kind: "rename"
  oldUri: string
  newUri: string
}

export interface DeleteFile {
  kind: "delete"
  uri: string
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[]
}

export interface PrepareRenameResult {
  range: Range
  placeholder?: string
}

export interface PrepareRenameDefaultBehavior {
  defaultBehavior: boolean
}

// ---------------------------------------------------------------------------
// Shared permission / target plumbing
// ---------------------------------------------------------------------------

export const lspPrepare = Effect.fn("LspUtil.prepare")(function* (input: {
  ctx: Tool.Context
  operation: string
  filePath: string
  /** 1-based line as supplied by the model (for position-based operations). */
  line?: number
  /** 0-based character as supplied by the model (for position-based operations). */
  character?: number
  query?: string
  newName?: string
  /** Omit the file path from the permission metadata (used by workspace/symbol). */
  omitFile?: boolean
  fs: FSUtil.Interface
  lsp: LSP.Interface
}) {
  const instance = yield* InstanceState.context
  const file = path.isAbsolute(input.filePath) ? input.filePath : path.join(instance.directory, input.filePath)
  yield* assertExternalDirectoryEffect(input.ctx, file)

  const metadata: Record<string, unknown> = { operation: input.operation }
  if (!input.omitFile) metadata.filePath = file
  if (input.line !== undefined) {
    metadata.line = input.line
    metadata.character = input.character
  }
  if (input.query !== undefined) metadata.query = input.query
  if (input.newName !== undefined) metadata.newName = input.newName
  yield* input.ctx.ask({
    permission: "lsp",
    patterns: ["*"],
    always: ["*"],
    metadata,
  })

  const exists = yield* input.fs.existsSafe(file)
  if (!exists) throw new Error(`File not found: ${file}`)

  const available = yield* input.lsp.hasClients(file)
  if (!available) throw new Error("No LSP server available for this file type.")
  yield* input.lsp.touchFile(file, "document")

  return file
})

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
}

const SEVERITY_NAMES: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
}

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `Unknown(${kind})`
}

export function severityName(severity: number | undefined): string {
  if (!severity) return "unknown"
  return SEVERITY_NAMES[severity] ?? `unknown(${severity})`
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

export function formatLocation(loc: Location | LocationLink): string {
  if ("targetUri" in loc) {
    return `${uriToPath(loc.targetUri)}:${loc.targetRange.start.line + 1}:${loc.targetRange.start.character}`
  }
  return `${uriToPath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character}`
}

export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string {
  const prefix = "  ".repeat(indent)
  const kind = symbolKindName(symbol.kind)
  const line = symbol.range.start.line + 1
  let result = `${prefix}${symbol.name} (${kind}) - line ${line}`
  if (symbol.children?.length) {
    for (const child of symbol.children) {
      result += "\n" + formatDocumentSymbol(child, indent + 1)
    }
  }
  return result
}

export function formatSymbolInfo(symbol: SymbolInfo): string {
  const kind = symbolKindName(symbol.kind)
  const loc = formatLocation(symbol.location)
  const container = symbol.containerName ? ` (in ${symbol.containerName})` : ""
  return `${symbol.name} (${kind})${container} - ${loc}`
}

export function formatDiagnostic(diag: Diagnostic): string {
  const severity = severityName(diag.severity)
  const line = diag.range.start.line + 1
  const char = diag.range.start.character
  const source = diag.source ? `[${diag.source}]` : ""
  const code = diag.code !== undefined && diag.code !== null && diag.code !== "" ? ` (${diag.code})` : ""
  return `${severity}${source}${code} at ${line}:${char}: ${diag.message}`
}

export function formatPrepareRenameResult(result: PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null | undefined): string {
  if (!result) return "Cannot rename at this position"

  // Case 1: { defaultBehavior: boolean }
  if ("defaultBehavior" in result) {
    return result.defaultBehavior ? "Rename supported (using default behavior)" : "Cannot rename at this position"
  }

  // Case 2: { range: Range, placeholder?: string }
  if ("range" in result && result.range) {
    const startLine = result.range.start.line + 1
    const startChar = result.range.start.character
    const endLine = result.range.end.line + 1
    const endChar = result.range.end.character
    const placeholder = result.placeholder ? ` (current: "${result.placeholder}")` : ""
    return `Rename available at ${startLine}:${startChar}-${endLine}:${endChar}${placeholder}`
  }

  // Case 3: Range directly
  if ("start" in result && "end" in result) {
    const startLine = result.start.line + 1
    const startChar = result.start.character
    const endLine = result.end.line + 1
    const endChar = result.end.character
    return `Rename available at ${startLine}:${startChar}-${endLine}:${endChar}`
  }

  return "Cannot rename at this position"
}

// ---------------------------------------------------------------------------
// Workspace edit application (pure text transformation; I/O is done by the tool)
// ---------------------------------------------------------------------------

export function formatTextEdit(edit: TextEdit): string {
  const startLine = edit.range.start.line + 1
  const startChar = edit.range.start.character
  const endLine = edit.range.end.line + 1
  const endChar = edit.range.end.character
  const rangeStr = `${startLine}:${startChar}-${endLine}:${endChar}`
  const preview = edit.newText.length > 50 ? `${edit.newText.substring(0, 50)}...` : edit.newText
  return `  ${rangeStr}: "${preview}"`
}

/** Applies edits to file content. Edits are applied in reverse position order. */
export function applyTextEdits(content: string, edits: TextEdit[]): string {
  if (edits.length === 0) return content
  const lines = content.split("\n")
  const sorted = [...edits].sort((a, b) => {
    if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line
    return b.range.start.character - a.range.start.character
  })
  for (const edit of sorted) {
    const { start, end } = edit.range
    if (start.line === end.line) {
      const line = lines[start.line] ?? ""
      lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character)
    } else {
      const first = lines[start.line] ?? ""
      const last = lines[end.line] ?? ""
      const replacement = first.slice(0, start.character) + edit.newText + last.slice(end.character)
      lines.splice(start.line, end.line - start.line + 1, ...replacement.split("\n"))
    }
  }
  return lines.join("\n")
}

export interface ApplyResult {
  success: boolean
  filesModified: string[]
  totalEdits: number
  errors: string[]
}

export function formatApplyResult(result: ApplyResult): string {
  const lines: string[] = []
  if (result.success) {
    lines.push(`Applied ${result.totalEdits} edit(s) to ${result.filesModified.length} file(s):`)
    for (const file of result.filesModified) {
      lines.push(`  - ${file}`)
    }
  } else {
    lines.push("Failed to apply some changes:")
    for (const error of result.errors) {
      lines.push(`  Error: ${error}`)
    }
    if (result.filesModified.length > 0) {
      lines.push(`Successfully modified: ${result.filesModified.join(", ")}`)
    }
  }
  return lines.join("\n")
}

/**
 * Effectful application of a WorkspaceEdit returned by textDocument/rename.
 * Asks for permission on any file outside the instance and writes changes
 * through the FSUtil service.
 */
export const applyWorkspaceEdit = Effect.fn("LspUtil.applyWorkspaceEdit")(function* (input: {
  ctx: Tool.Context
  edit: unknown
  fs: FSUtil.Interface
}) {
  const edit = input.edit as WorkspaceEdit | null | undefined
  if (!edit) {
    return {
      success: false,
      filesModified: [],
      totalEdits: 0,
      errors: ["No workspace edit returned by the language server"],
    }
  }

  const fs = input.fs
  const result: ApplyResult = { success: true, filesModified: [], totalEdits: 0, errors: [] }

  const applyFileEdits = Effect.fn("LspUtil.applyFileEdits")(function* (filePath: string, edits: TextEdit[]) {
    yield* assertExternalDirectoryEffect(input.ctx, filePath)
    const content = yield* fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content === undefined) {
      result.success = false
      result.errors.push(`${filePath}: failed to read file`)
      return
    }
    const next = applyTextEdits(content, edits)
    yield* fs.writeFileString(filePath, next).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          result.filesModified.push(filePath)
          result.totalEdits += edits.length
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          result.success = false
          result.errors.push(`${filePath}: ${error}`)
        }),
      ),
    )
  })

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      yield* applyFileEdits(uriToPath(uri), edits)
    }
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("kind" in change) {
        if (change.kind === "create") {
          const filePath = uriToPath(change.uri)
          yield* assertExternalDirectoryEffect(input.ctx, filePath)
          yield* fs.writeFileString(filePath, "").pipe(
            Effect.tap(() => Effect.sync(() => result.filesModified.push(filePath))),
            Effect.catch((error) =>
              Effect.sync(() => {
                result.success = false
                result.errors.push(`Create ${filePath}: ${error}`)
              }),
            ),
          )
        } else if (change.kind === "rename") {
          const oldPath = uriToPath(change.oldUri)
          const newPath = uriToPath(change.newUri)
          yield* assertExternalDirectoryEffect(input.ctx, oldPath)
          yield* assertExternalDirectoryEffect(input.ctx, newPath)
          yield* fs.rename(oldPath, newPath).pipe(
            Effect.tap(() => Effect.sync(() => result.filesModified.push(newPath))),
            Effect.catch((error) =>
              Effect.sync(() => {
                result.success = false
                result.errors.push(`Rename ${oldPath} -> ${newPath}: ${error}`)
              }),
            ),
          )
        } else if (change.kind === "delete") {
          const filePath = uriToPath(change.uri)
          yield* assertExternalDirectoryEffect(input.ctx, filePath)
          yield* fs.remove(filePath).pipe(
            Effect.tap(() => Effect.sync(() => result.filesModified.push(filePath))),
            Effect.catch((error) =>
              Effect.sync(() => {
                result.success = false
                result.errors.push(`Delete ${filePath}: ${error}`)
              }),
            ),
          )
        }
      } else {
        yield* applyFileEdits(uriToPath(change.textDocument.uri), change.edits)
      }
    }
  }

  return result
})
