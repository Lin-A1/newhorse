// Render a mermaid fenced block into a compact text/ASCII summary suitable
// for terminal output. The full source is always preserved so the diagram is
// still inspectable in-place; the summary just adds a one-screen overview.
//
// Format:
//   ┌─ mermaid ──────────────────────────── N nodes / M edges ─┐
//   : graph / flowchart / sequenceDiagram / ...
//   : nodes: A, B, C, ...
//   : edges: A --> B, B --> C, ...
//   └──────────────────────────────────────────────────────────┘
//
// This avoids pulling the heavy mermaid renderer into the TUI bundle while
// still giving operators enough to spot-check what's in the diagram.

const MERMAID_FENCE = /^(\s*)```mermaid\s*\n([\s\S]*?)\n?\s*```\s*$/gm

type ParsedBlock = {
  indent: string
  body: string
}

export function collectMermaidBlocks(markdown: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  for (const match of markdown.matchAll(MERMAID_FENCE)) {
    blocks.push({ indent: match[1] ?? "", body: match[2] ?? "" })
  }
  return blocks
}

export function renderMermaidASCII(body: string): string {
  const header = parseHeader(body)
  const { nodes, edges, sequence } = parseDiagram(body, header.kind)

  const lines: string[] = []
  const title = `[mermaid: ${header.kind}]`
  lines.push(title)
  if (header.title) lines.push(`title: ${header.title}`)
  if (header.note) lines.push(...header.note.map((n) => `note: ${n}`))
  lines.push("")

  if (header.kind === "sequenceDiagram") {
    lines.push(...sequence)
  } else {
    lines.push(`nodes (${nodes.length}): ${nodes.join(", ") || "(none detected)"}`)
    if (edges.length > 0) {
      lines.push("")
      lines.push(`edges (${edges.length}):`)
      const max = Math.min(edges.length, 8)
      for (const edge of edges.slice(0, max)) lines.push(`  ${edge}`)
      if (edges.length > max) lines.push(`  … +${edges.length - max} more`)
    } else if (nodes.length === 0) {
      lines.push("(diagram body preserved below)")
    }
  }

  return lines.join("\n")
}

// Replace every mermaid fenced block in a markdown stream with a compact
// ASCII rendering. Used by the TUI scrollback so terminal users get a
// readable diagram preview without loading the browser renderer.
export function renderMermaidASCIIInMarkdown(markdown: string): string {
  return markdown.replace(MERMAID_FENCE, (_, indent: string, body: string) => {
    const rendered = renderMermaidASCII(body)
    const prefix = indent ?? ""
    const out = rendered
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n")
    return out
  })
}

type Header = {
  kind: string
  title?: string
  note: string[]
}

function parseHeader(body: string): Header {
  const lines = body.split(/\r?\n/)
  const first = lines[0]?.trim() ?? ""
  // Keep the full first line as kind ("graph LR", "flowchart TD",
  // "sequenceDiagram") so the summary preserves the diagram's orientation.
  const kind = first || "diagram"
  const title: string[] = []
  const note: string[] = []
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("title ")) title.push(trimmed.slice(6).trim())
    else if (trimmed.startsWith("note ")) {
      // "note left of A: foo" / "note over A: foo" / "note: foo" — strip the
      // position keyword so the summary reads as a plain note.
      const stripped = trimmed.slice(5).replace(/^(left|right|over|top|bottom)(?:\s+(?:of\s+)?[^:]+)?:\s*/, "")
      note.push(stripped)
    }
  }
  return { kind, title: title[0], note }
}

type ParsedDiagram = {
  nodes: string[]
  edges: string[]
  sequence: string[]
}

function parseDiagram(body: string, kind: string): ParsedDiagram {
  if (kind === "sequenceDiagram") return parseSequence(body)
  return parseGraph(body)
}

function parseGraph(body: string): ParsedDiagram {
  const nodes = new Set<string>()
  const edges: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("%%")) continue
    if (line.startsWith("title ") || line.startsWith("note ") || line.startsWith("subgraph ")) continue
    if (line === "end") continue
    // Strip any node-shape suffix ([label], (label), {label}, [/label/])
    // before matching the edge so "A[Login] --> B{Home}" resolves cleanly.
    const shaped = (id: string) => id.match(/^([A-Za-z0-9_\-]+)/)?.[1] ?? id
    const arrowMatch = line.match(
      /^([A-Za-z0-9_\-]+)(?:\s*[\[\(\{][^\]\)\}]*[\]\)\}])?\s*(?:-->|---|->>|--o|--x)(?:\s*\|([^|]+)\|)?\s*([A-Za-z0-9_\-]+)(?:\s*[\[\(\{][^\]\)\}]*[\]\)\}])?(?:\s*:\s*(.+))?$/,
    )
    if (arrowMatch) {
      const [, from, edgeLabel, to, trailing] = arrowMatch
      const fromId = shaped(from)
      const toId = shaped(to)
      nodes.add(fromId)
      nodes.add(toId)
      const labels = [edgeLabel?.trim(), trailing?.trim()].filter(Boolean)
      const labelStr = labels.length > 0 ? ` [${labels.join(" : ")}]` : ""
      edges.push(`${fromId} → ${toId}${labelStr}`)
      continue
    }
    const nodeMatch = line.match(/^([A-Za-z0-9_\-]+)(?:\s*[\[\(\{].*[\]\)\}])?\s*$/)
    if (nodeMatch) nodes.add(nodeMatch[1])
  }
  return { nodes: [...nodes], edges, sequence: [] }
}

function parseSequence(body: string): ParsedDiagram {
  const actors = new Set<string>()
  const events: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("%%")) continue
    const participant = line.match(/^(?:participant|actor)\s+([A-Za-z0-9_\-]+)/)
    if (participant) {
      actors.add(participant[1])
      continue
    }
    const message = line.match(/^([A-Za-z0-9_\-]+?)\s*(?:->>|->|-->>?|--)\s*([A-Za-z0-9_\-]+?)\s*:\s*(.+)$/)
    if (message) {
      actors.add(message[1])
      actors.add(message[2])
      events.push(`${message[1]} → ${message[2]}: ${message[3].trim()}`)
      continue
    }
    const note = line.match(/^note\s+(?:over\s+)?([A-Za-z0-9_\-]+?)\s*:?\s*(.*)$/)
    if (note) events.push(`note over ${note[1]}: ${note[2].trim()}`)
  }
  const seq: string[] = []
  seq.push(`actors (${actors.size}): ${[...actors].join(", ") || "(none detected)"}`)
  if (events.length > 0) {
    seq.push("")
    seq.push(`messages (${events.length}):`)
    for (const event of events.slice(0, 12)) seq.push(`  ${event}`)
    if (events.length > 12) seq.push(`  … +${events.length - 12} more`)
  }
  return { nodes: [...actors], edges: events, sequence: seq }
}