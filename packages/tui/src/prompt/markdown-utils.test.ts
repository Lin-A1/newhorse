import { describe, expect, it } from "bun:test"
import { continuationForLine, listItemPrefix } from "./markdown-utils"

describe("continuationForLine", () => {
  it("increments ordered list numbers, including multi-digit", () => {
    expect(continuationForLine("1. task")).toBe("2. ")
    expect(continuationForLine("9. task")).toBe("10. ")
    expect(continuationForLine("10. task")).toBe("11. ")
    expect(continuationForLine("1) task")).toBe("2) ")
    expect(continuationForLine("2. ")).toBe("3. ")
  })

  it("keeps the same symbol for unordered lists", () => {
    expect(continuationForLine("- task")).toBe("- ")
    expect(continuationForLine("* task")).toBe("* ")
    expect(continuationForLine("+ task")).toBe("+ ")
  })

  it("continues blockquotes and indentation", () => {
    expect(continuationForLine("> quote")).toBe("> ")
    expect(continuationForLine("\tcode")).toBe("\t")
  })

  it("returns null for non-matching lines", () => {
    expect(continuationForLine("plain text")).toBeNull()
    expect(continuationForLine("")).toBeNull()
  })
})

describe("listItemPrefix", () => {
  it("detects bare list item prefixes for exiting", () => {
    expect(listItemPrefix("2. ")).toBe("2. ")
    expect(listItemPrefix("3)")).toBe("3) ")
    expect(listItemPrefix("- ")).toBe("- ")
    expect(listItemPrefix("*")).toBe("* ")
    expect(listItemPrefix("+ ")).toBe("+ ")
    expect(listItemPrefix("> ")).toBe("> ")
    expect(listItemPrefix("\t")).toBe("\t")
  })

  it("returns null when the line has content", () => {
    expect(listItemPrefix("1. task")).toBeNull()
    expect(listItemPrefix("- task")).toBeNull()
    expect(listItemPrefix("> quote")).toBeNull()
    expect(listItemPrefix("\tcode")).toBeNull()
    expect(listItemPrefix("plain text")).toBeNull()
  })
})
