import React from "react"

/**
 * Minimal markdown renderer for assistant turns — headings, fenced code,
 * lists, bold, inline code, links. React-element output (no HTML injection).
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks: React.ReactElement[] = []
  const lines = text.split("\n")
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        buf.push(lines[i]!)
        i++
      }
      i++ // closing fence
      blocks.push(
        <pre key={key++} className="block">
          {lang && <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">{lang}</div>}
          <code>{buf.join("\n")}</code>
        </pre>,
      )
      continue
    }
    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length
      const content = inline(line.replace(/^#+\s*/, ""))
      blocks.push(level === 1 ? <h1 key={key++}>{content}</h1> : level === 2 ? <h2 key={key++}>{content}</h2> : <h3 key={key++}>{content}</h3>)
      i++
      continue
    }
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const ordered = /^\d+\.\s/.test(line)
      const items: React.ReactElement[] = []
      while (i < lines.length && (/^[-*]\s/.test(lines[i]!) || /^\d+\.\s/.test(lines[i]!))) {
        items.push(<li key={items.length}>{inline(lines[i]!.replace(/^([-*]|\d+\.)\s*/, ""))}</li>)
        i++
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>)
      continue
    }
    if (line.trim() === "") {
      i++
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^#{1,3}\s/.test(lines[i]!) && !/^[-*]\s/.test(lines[i]!) && !/^\d+\.\s/.test(lines[i]!)) {
      buf.push(lines[i]!)
      i++
    }
    blocks.push(
      <p key={key++}>{inline(buf.join("\n"))}</p>,
    )
  }
  return <div className="md">{blocks}</div>
}

/** Inline: **bold**, `code`, [text](url) */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    if (token.startsWith("**")) out.push(<strong key={k++} className="text-slate-100">{token.slice(2, -2)}</strong>)
    else if (token.startsWith("`")) out.push(<code key={k++} className="inline">{token.slice(1, -1)}</code>)
    else {
      const mm = token.match(/\[([^\]]+)\]\(([^)]+)\)/)!
      out.push(
        <a key={k++} href={mm[2]} target="_blank" rel="noreferrer">
          {mm[1]}
        </a>,
      )
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
