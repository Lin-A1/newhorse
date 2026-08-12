import { describe, expect, it } from "bun:test"
import {
  applyTextEdits,
  formatLocation,
  formatPrepareRenameResult,
  type TextEdit,
} from "../../src/tool/lsp-util"

describe("lsp-util.applyTextEdits", () => {
  it("applies a single-line replacement", () => {
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } }, newText: "newName" },
    ]
    expect(applyTextEdits("export const oldName = 1\n", edits)).toBe("export const newName = 1\n")
  })

  it("applies multiple edits in reverse position order", () => {
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "AAA" },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "BBB" },
    ]
    expect(applyTextEdits("foo\nbar\n", edits)).toBe("AAA\nBBB\n")
  })

  it("replaces content across multiple lines", () => {
    const edits: TextEdit[] = [
      {
        range: { start: { line: 0, character: 5 }, end: { line: 2, character: 3 } },
        newText: "one\ntwo",
      },
    ]
    expect(applyTextEdits("abcde\nfghij\nklmno\n", edits)).toBe("abcdeone\ntwono\n")
  })

  it("preserves CRLF line endings", () => {
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "XXX" },
    ]
    expect(applyTextEdits("foo\r\nbar\r\n", edits)).toBe("XXX\r\nbar\r\n")
  })

  it("returns the original content when there are no edits", () => {
    expect(applyTextEdits("hello\n", [])).toBe("hello\n")
  })
})

describe("lsp-util.formatLocation", () => {
  const fileUri = process.platform === "win32" ? "file:///C:/a/b.ts" : "file:///a/b.ts"
  const filePath = process.platform === "win32" ? "C:\\a\\b.ts" : "/a/b.ts"

  it("formats a plain location with a 1-based line", () => {
    expect(
      formatLocation({
        uri: fileUri,
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 5 } },
      }),
    ).toBe(`${filePath}:3:4`)
  })

  it("formats a location link with a 1-based target line", () => {
    expect(
      formatLocation({
        targetUri: fileUri,
        targetRange: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
        targetSelectionRange: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
      }),
    ).toBe(`${filePath}:1:1`)
  })

  it("leaves non-file URIs untouched", () => {
    expect(
      formatLocation({
        uri: "untitled:Untitled-1",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      }),
    ).toBe("untitled:Untitled-1:1:0")
  })
})

describe("lsp-util.formatPrepareRenameResult", () => {
  it("formats a range result with placeholder", () => {
    expect(
      formatPrepareRenameResult({
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } },
        placeholder: "x",
      }),
    ).toBe('Rename available at 1:7-1:8 (current: "x")')
  })

  it("formats a default-behavior result", () => {
    expect(formatPrepareRenameResult({ defaultBehavior: true })).toBe("Rename supported (using default behavior)")
    expect(formatPrepareRenameResult({ defaultBehavior: false })).toBe("Cannot rename at this position")
  })

  it("reports cannot rename for nullish input", () => {
    expect(formatPrepareRenameResult(null)).toBe("Cannot rename at this position")
    expect(formatPrepareRenameResult(undefined)).toBe("Cannot rename at this position")
  })
})
