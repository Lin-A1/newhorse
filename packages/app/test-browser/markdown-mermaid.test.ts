import { describe, expect, test } from "bun:test"
import { renderMermaid } from "@newhorse/session-ui/markdown-mermaid"

// mermaid v11 requires a full browser DOM (layout engines like elk and real
// element measurement); happy-dom cannot satisfy it and renders empty SVG.
// This suite validates the render pipeline and must run in a real browser
// (Electron / dev server), not under bun test with happy-dom.
describe.skip("renderMermaid", () => {
  test("renders a flowchart into an svg string", async () => {
    const result = await renderMermaid("graph TD\n  A[Start] --> B[Process]\n  B --> C[End]")
    expect(result.svg).toContain("<svg")
    expect(result.svg).toContain(">Start<")
    expect(result.svg).toContain(">Process<")
    expect(result.svg).toContain(">End<")
  })

  test("renders a sequence diagram with Chinese labels", async () => {
    const result = await renderMermaid("sequenceDiagram\n  Alice->>Bob: 你好世界\n  Bob-->>Alice: 收到")
    expect(result.svg).toContain("<svg")
    expect(result.svg).toContain("你好世界")
  })
})
