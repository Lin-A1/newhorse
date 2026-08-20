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
export const HOUR_MS = 60 * 60 * 1000

/** Top rows to render; anything beyond is the user's tail of tiny app slices. */
export const MAX_GANTT_ROWS = 8

export const dayStartMs = (now = Date.now()) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const timelineEndHour = (now = Date.now()) => {
  const date = new Date(now)
  return Math.min(24, Math.max(2, Math.ceil((date.getHours() + date.getMinutes() / 60) / 2) * 2))
}

export const appColorIndex = (app: string, colorCount: number) => {
  if (colorCount < 1) return 0
  return [...app].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % colorCount
}

export const GAP_THRESHOLD_MS = 70 * 60 * 1000
export const COMPRESSED_GAP_MS = 14 * 60 * 1000

export type CompressedGap = { start: number; end: number; duration: number }

export function collectMergedIntervals(rows: PresenceRow[], dayStart: number, endMs: number): Array<{ start: number; end: number }> {
  const all = rows.flatMap((row) => row.segments.map((segment) => ({ start: segment.start, end: Math.min(segment.end, endMs) })))
  if (all.length === 0) return []
  all.sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const interval of all) {
    const last = merged[merged.length - 1]
    if (!last || interval.start > last.end) merged.push({ ...interval })
    else last.end = Math.max(last.end, interval.end)
  }
  // Clamp to window
  return merged.map((interval) => ({ start: Math.max(interval.start, dayStart), end: Math.min(interval.end, endMs) })).filter((interval) => interval.end > interval.start)
}

export function buildCompressedGaps(rows: PresenceRow[], dayStart: number, endMs: number): CompressedGap[] {
  const merged = collectMergedIntervals(rows, dayStart, endMs)
  if (merged.length === 0) {
    const duration = endMs - dayStart
    return duration > GAP_THRESHOLD_MS ? [{ start: dayStart, end: endMs, duration }] : []
  }
  const gaps: CompressedGap[] = []
  // Leading gap
  const first = merged[0]!
  if (first.start - dayStart > GAP_THRESHOLD_MS) gaps.push({ start: dayStart, end: first.start, duration: first.start - dayStart })
  // Middle gaps
  for (let index = 1; index < merged.length; index++) {
    const previous = merged[index - 1]!
    const current = merged[index]!
    const duration = current.start - previous.end
    if (duration > GAP_THRESHOLD_MS) gaps.push({ start: previous.end, end: current.start, duration })
  }
  // Trailing gap
  const last = merged[merged.length - 1]!
  if (endMs - last.end > GAP_THRESHOLD_MS) gaps.push({ start: last.end, end: endMs, duration: endMs - last.end })
  return gaps
}

export function compressedTotalMs(dayStart: number, endMs: number, gaps: CompressedGap[]): number {
  const total = endMs - dayStart
  const saved = gaps.reduce((sum, gap) => sum + (gap.duration - COMPRESSED_GAP_MS), 0)
  return Math.max(1, total - saved)
}

export function timeToCompressedRatio(time: number, dayStart: number, gaps: CompressedGap[]): number {
  let offset = time - dayStart
  for (const gap of gaps) {
    if (time <= gap.start) break
    if (time >= gap.end) offset -= gap.duration - COMPRESSED_GAP_MS
    else {
      // Time inside a compressed gap: map proportionally inside the compressed gap
      const inside = time - gap.start
      const ratio = inside / gap.duration
      offset = gap.start - dayStart - gaps.filter((candidate) => candidate.end <= gap.start).reduce((sum, candidate) => sum + (candidate.duration - COMPRESSED_GAP_MS), 0) + ratio * COMPRESSED_GAP_MS
      break
    }
  }
  return offset
}

export function compressedRatioToPercent(ratioOffset: number, totalCompressed: number): number {
  return Math.max(0, Math.min(100, (ratioOffset / totalCompressed) * 100))
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
