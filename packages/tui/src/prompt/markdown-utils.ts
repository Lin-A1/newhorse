export function continuationForLine(line: string): string | null {
  const ordered = /^(\d+)([.)])\s/.exec(line)
  if (ordered) return `${Number(ordered[1]) + 1}${ordered[2]} `

  const bullet = /^([-*+])\s/.exec(line)
  if (bullet) return `${bullet[1]} `

  if (/^>\s/.test(line)) return "> "

  if (line.startsWith("\t")) return "\t"

  return null
}

export function listItemPrefix(line: string): string | null {
  const ordered = /^(\d+[.)])$/.exec(line.trimEnd())
  if (ordered) return `${ordered[1]} `

  const bullet = /^([-*+])$/.exec(line.trimEnd())
  if (bullet) return `${bullet[1]} `

  if (/^>$/.test(line.trimEnd())) return "> "

  if (line.startsWith("\t") && line.trim() === "") return "\t"

  return null
}
