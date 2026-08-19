import { describe, expect, test } from "bun:test"
import { ToolJsonSchema } from "../../src/tool/json-schema"

import READ_DESCRIPTION from "../../src/tool/read.txt"
import EDIT_DESCRIPTION from "../../src/tool/edit.txt"
import WRITE_DESCRIPTION from "../../src/tool/write.txt"
import GLOB_DESCRIPTION from "../../src/tool/glob.txt"
import GREP_DESCRIPTION from "../../src/tool/grep.txt"
import { Parameters as Edit } from "../../src/tool/edit"
import { Parameters as Read } from "../../src/tool/read"
import { Parameters as Write } from "../../src/tool/write"
import { Parameters as Glob } from "../../src/tool/glob"
import { Parameters as Grep } from "../../src/tool/grep"

// These assertions pin the LLM-facing tool descriptions and JSON Schemas to
// behaviors that prevent wrong tool calls: path semantics must mention the
// working directory, and when-to-use guidance must disambiguate similar tools
// (read vs grep vs glob, edit vs write, regex vs glob for grep).
//
// NOTE: the schema objects returned by ToolJsonSchema.fromSchema are cached, so
// tests must read description strings into plain values and assert with
// string matchers. Passing the shared object to a matcher such as
// `toMatchObject({ description: expect.stringContaining(...) })` mutates it and
// corrupts the snapshot tests in parameters.test.ts when both files share a
// process.

const descriptionOf = (schema: ReturnType<typeof ToolJsonSchema.fromSchema>, key: string) =>
  (schema.properties?.[key] as { description?: string } | undefined)?.description ?? ""

describe("file tool descriptions", () => {
  test("read mentions working-directory path resolution and does not imply content search", () => {
    expect(READ_DESCRIPTION).toContain("Working directory")
    expect(READ_DESCRIPTION).toContain("相对路径")
    expect(READ_DESCRIPTION).toContain("grep")
    expect(READ_DESCRIPTION).toContain("glob")
  })

  test("edit mentions working-directory path resolution and disambiguates from write", () => {
    expect(EDIT_DESCRIPTION).toContain("Working directory")
    expect(EDIT_DESCRIPTION).toContain("write")
    expect(EDIT_DESCRIPTION).toContain("oldString")
  })

  test("write mentions working-directory path resolution and disambiguates from edit", () => {
    expect(WRITE_DESCRIPTION).toContain("Working directory")
    expect(WRITE_DESCRIPTION).toContain("edit")
  })

  test("glob says results are absolute paths and defers content search to grep", () => {
    expect(GLOB_DESCRIPTION).toContain("绝对路径")
    expect(GLOB_DESCRIPTION).toContain("grep")
    expect(GLOB_DESCRIPTION).toContain("Working directory")
  })

  test("grep says pattern is a regex (not a glob) and defers name lookup to glob", () => {
    expect(GREP_DESCRIPTION).toContain("正则表达式")
    expect(GREP_DESCRIPTION).toContain("glob")
    expect(GREP_DESCRIPTION).toContain("Working directory")
  })
})

describe("file tool parameter schemas", () => {
  test("edit filePath schema mentions working-directory resolution", () => {
    expect(descriptionOf(ToolJsonSchema.fromSchema(Edit), "filePath")).toContain("working directory")
  })

  test("read filePath schema mentions working-directory resolution", () => {
    expect(descriptionOf(ToolJsonSchema.fromSchema(Read), "filePath")).toContain("working directory")
  })

  test("write filePath schema mentions working-directory resolution", () => {
    expect(descriptionOf(ToolJsonSchema.fromSchema(Write), "filePath")).toContain("working directory")
  })

  test("grep pattern schema says regex not glob and points to include", () => {
    expect(descriptionOf(ToolJsonSchema.fromSchema(Grep), "pattern")).toContain("regex")
  })

  test("glob pattern schema says the pattern is relative to path", () => {
    expect(descriptionOf(ToolJsonSchema.fromSchema(Glob), "pattern")).toContain("relative to")
  })

  test("glob path schema stays optional in required", () => {
    expect(ToolJsonSchema.fromSchema(Glob).required).toEqual(["pattern"])
  })
})
