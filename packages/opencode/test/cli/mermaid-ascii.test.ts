import { describe, expect, test } from "bun:test"
import { collectMermaidBlocks, renderMermaidASCII, renderMermaidASCIIInMarkdown } from "../../src/cli/cmd/run/mermaid-ascii.ts"

describe("renderMermaidASCII", () => {
  test("summarises a graph diagram", () => {
    const body = [
      "graph LR",
      "  A[Login] --> B{Session valid?}",
      "  B -->|yes| C[Dashboard]",
      "  B -->|no| D[Logout]",
    ].join("\n")
    const out = renderMermaidASCII(body)
    expect(out).toContain("[mermaid: graph LR]")
    expect(out).toContain("nodes (4): A, B, C, D")
    expect(out).toContain("edges (3):")
    expect(out).toContain("A → B")
    expect(out).toContain("B → C")
    expect(out).toContain("B → D")
  })

  test("summarises a sequence diagram", () => {
    const body = [
      "sequenceDiagram",
      "  participant U as User",
      "  participant S as Server",
      "  U->>S: GET /login",
      "  S-->>U: 200 OK",
    ].join("\n")
    const out = renderMermaidASCII(body)
    expect(out).toContain("[mermaid: sequenceDiagram]")
    expect(out).toContain("actors (2): U, S")
    expect(out).toContain("U → S: GET /login")
    expect(out).toContain("S → U: 200 OK")
  })

  test("preserves title and notes", () => {
    const body = ["graph TD", "  title Auth flow", "  note top: secrets never leave the device", "  A-->B"].join("\n")
    const out = renderMermaidASCII(body)
    expect(out).toContain("title: Auth flow")
    expect(out).toContain("note: secrets never leave the device")
  })

  test("handles an empty / unknown body", () => {
    const out = renderMermaidASCII("")
    expect(out).toContain("[mermaid: diagram]")
    expect(out).toContain("(none detected)")
  })
})

describe("renderMermaidASCIIInMarkdown", () => {
  test("replaces fenced mermaid blocks with ASCII summaries", () => {
    const md = [
      "Here is a flow:",
      "",
      "```mermaid",
      "graph LR",
      "  A --> B",
      "  B --> C",
      "```",
      "",
      "After the diagram.",
    ].join("\n")
    const out = renderMermaidASCIIInMarkdown(md)
    expect(out).toContain("[mermaid: graph LR]")
    expect(out).toContain("nodes (3): A, B, C")
    expect(out).toContain("A → B")
    expect(out).toContain("After the diagram.")
    expect(out).not.toContain("```mermaid")
  })

  test("leaves non-mermaid code blocks alone", () => {
    const md = ["```ts", "const x = 1", "```"].join("\n")
    expect(renderMermaidASCIIInMarkdown(md)).toBe(md)
  })

  test("skips incomplete streaming fences (no closing ```)", () => {
    const md = ["```mermaid", "graph LR", "  A --> B"].join("\n")
    expect(renderMermaidASCIIInMarkdown(md)).toBe(md)
  })
})

describe("collectMermaidBlocks", () => {
  test("collects every fenced mermaid block", () => {
    const md = ["A", "```mermaid", "graph LR", "  A --> B", "```", "B", "```mermaid", "graph TD", "  X --> Y", "```"].join(
      "\n",
    )
    const blocks = collectMermaidBlocks(md)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.body).toContain("A --> B")
    expect(blocks[1]?.body).toContain("X --> Y")
  })
})