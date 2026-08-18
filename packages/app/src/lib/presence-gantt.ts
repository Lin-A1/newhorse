// Client-side presence Gantt grouping: today's focus-app segments become one
// row per app, ordered by total foreground time, so a day reads as "which apps,
// and when" instead of a single flat bar. Kept pure and dependency-free so the
// workbench can unit-test the grouping without mounting the component.

export type PresenceSegment = { app: string; start: number | string; end?: number | string }

export type PresenceBar = { start: number; end: number }

export type PresenceRow = {
  app: string
  totalMs: number
  segments: PresenceBar[]
}

export const DAY_MS = 24 * 60 * 60 * 1000

/** Top rows to render; anything beyond is the user's tail of tiny app slices. */
export const MAX_GANTT_ROWS = 8

export const dayStartMs = (now = Date.now()) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Group segments by app, clamp them to today's window, and return the top rows
// by total duration (longest first). A live segment (no end) runs to `now`.
export function groupSegments(segments: PresenceSegment[], now = Date.now()): PresenceRow[] {
  const dayStart = dayStartMs(now)
  const byApp = new Map<string, PresenceRow>()
  for (const segment of segments) {
    const start = Number(segment.start)
    if (!Number.isFinite(start)) continue
    const end = segment.end === undefined ? now : Number(segment.end)
    const begin = Math.max(start, dayStart)
    if (!Number.isFinite(end) || end <= begin) continue
    const row = byApp.get(segment.app)
    if (row) {
      row.segments.push({ start: begin, end })
      row.totalMs += end - begin
    } else {
      byApp.set(segment.app, { app: segment.app, totalMs: end - begin, segments: [{ start: begin, end }] })
    }
  }
  return [...byApp.values()]
    .map((row) => ({ ...row, segments: row.segments.sort((a, b) => a.start - b.start) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, MAX_GANTT_ROWS)
}

export const formatDuration = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}m`
  if (rest === 0) return `${hours}h`
  return `${hours}h${rest}m`
}
