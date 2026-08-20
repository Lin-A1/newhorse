import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { PresenceSegmentTable } from "@newhorse/core/presence/sql"
import { SessionTable } from "@newhorse/core/session/sql"
import { desc, eq, lt } from "drizzle-orm"
import { Context, Effect, Layer, Ref, Schema } from "effect"

// Bounded, host-owned presence (HANDOFF: no resident daemon). The server
// derives idle time from the most recent session activity in the instance —
// no polling loop, no native hooks — unless the desktop host reports richer
// signal (locked / foreground app / meeting) via Presence.update. Desktop
// sensing stays request-driven: the host queries the OS when get-presence is
// called and pushes the result with update; nothing runs on a timer.
export const Info = Schema.Struct({
  idleMs: Schema.Number,
  locked: Schema.Boolean,
  focusApp: Schema.optional(Schema.String),
  inMeeting: Schema.Boolean,
  observedAt: Schema.Number,
})
export type Info = Schema.Schema.Type<typeof Info>

// The subset a desktop host can report. idleMs is still derived from session
// activity; the other fields come from the OS foreground/window state.
export const Extras = Schema.Struct({
  locked: Schema.Boolean,
  focusApp: Schema.optional(Schema.String),
  inMeeting: Schema.Boolean,
})
export type Extras = Schema.Schema.Type<typeof Extras>

type RefState = Extras & { observedAt: number }
const STALE_AFTER_MS = 45_000

// Pure timeline projection: an open segment is "live" only while the host has
// actually reported in the stale window. Segment start alone is not enough —
// a user sitting in the same app for hours would otherwise go dark after the
// first stale window even though updates keep arriving. `lastSeen` is the last
// update observation (0 = never in this process, e.g. a restored DB segment
// after a restart, which must not render as live until the host reports again).
export function projectTimeline(
  segments: Segment[],
  opts: { now: number; dayStart: number; lastSeen: number; staleAfterMs: number },
): { segments: Segment[]; live: boolean } {
  const { now, dayStart, lastSeen, staleAfterMs } = opts
  // Defensive rollover: an open segment persisted from a previous day (or
  // seeded from a stale DB row) is clamped to midnight so it never renders
  // as a full-width bar in today's Gantt.
  const kept = segments
    .map((segment) =>
      segment.end === undefined && segment.start < dayStart ? { ...segment, end: dayStart } : segment,
    )
    .filter((segment) => (segment.end ?? now) >= dayStart)
  const fresh = lastSeen > 0 && now - lastSeen <= staleAfterMs
  // A single live segment (end undefined) plus a fresh host report means the
  // host is active right now. A stale/absent report closes the open segment at
  // the last known observation so the Gantt never shows an eternal bar.
  const live = fresh && kept.some((segment) => segment.end === undefined)
  const resolved = kept.map((segment) =>
    segment.end === undefined && !fresh ? { ...segment, end: Math.max(segment.start, lastSeen) } : segment,
  )
  return { segments: [...resolved].reverse(), live }
}

export const Segment = Schema.Struct({
  app: Schema.String,
  start: Schema.Number,
  end: Schema.optional(Schema.Number),
})
export type Segment = Schema.Schema.Type<typeof Segment>

// A day's focus-app Gantt: one row per app, each with contiguous segments of
// when that app was the OS foreground window (desktop-only, derived from
// Presence.update reports). This is what the workbench "感知" panel renders.
export const Timeline = Schema.Struct({
  /** Segments for today (local day), newest first. */
  segments: Schema.Array(Segment),
  /** Whether the current segment is still open (the host is active right now). */
  live: Schema.Boolean,
})
export type Timeline = Schema.Schema.Type<typeof Timeline>

export interface Interface {
  readonly get: (input: { directory: string }) => Effect.Effect<Info>
  readonly update: (extras: Extras) => Effect.Effect<void>
  readonly timeline: () => Effect.Effect<Timeline>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Presence") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // Process-local override reported by the desktop sidecar. Absent in
    // standalone CLI/background fibers, where get falls back to session-derived
    // idle only (locked: false, no focusApp).
    const extras = yield* Ref.make<RefState | undefined>(undefined)
    // Last wall-clock observation from update(), 0 until the first report in
    // this process. A restored DB segment must not render as live until the
    // host actually reports again (see projectTimeline).
    const lastSeen = yield* Ref.make(0)

    const dayStart = () => {
      const d = new Date(Date.now())
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }

    const dayKey = (start: number) => {
      const d = new Date(start)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    }

    // Focus-app segments for today (local day). Seeded from the DB so a fresh
    // process still serves persisted segments before any new update arrives.
    const persisted = yield* db
      .select()
      .from(PresenceSegmentTable)
      .where(eq(PresenceSegmentTable.day, dayKey(dayStart())))
      .all()
      .pipe(Effect.orDie)
    const segments = yield* Ref.make<Segment[]>(
      persisted
        // Never seed an empty-app segment: update() only opens on a real app
        // name, and a legacy "" row would render as a one-row one-bar Gantt
        // with an empty label while staying open for every failed probe.
        .filter((row) => row.app.length > 0 && Number.isFinite(row.start))
        .map((row) => ({ app: row.app, start: row.start, end: row.end ?? undefined })),
    )

    const get = Effect.fn("Presence.get")(function* (input: { directory: string }) {
      const now = Date.now()
      const last = yield* db
        .select({ time_updated: SessionTable.time_updated })
        .from(SessionTable)
        .where(eq(SessionTable.directory, input.directory))
        .orderBy(desc(SessionTable.time_updated))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const lastActivity = last?.time_updated ?? now
      const reported = yield* Ref.get(extras)
      const fresh = reported && now - reported.observedAt <= STALE_AFTER_MS ? reported : undefined
      return {
        idleMs: Math.max(0, now - lastActivity),
        locked: fresh?.locked ?? false,
        focusApp: fresh?.focusApp,
        inMeeting: fresh?.inMeeting ?? false,
        observedAt: fresh?.observedAt ?? now,
      } satisfies Info
    })

    const update = Effect.fn("Presence.update")(function* (input: Extras) {
      const now = Date.now()
      yield* Ref.set(extras, { ...input, observedAt: now })
      yield* Ref.set(lastSeen, now)

      // Grow the focus-app Gantt: close the previous segment at `now` when the
      // app changed, then start/keep the current app's segment. Segments older
      // than today are dropped (the panel only shows the current day). An
      // empty focusApp is an unknown reading (probe failure): leave the open
      // segment as-is so it never fragments the timeline with zero-length gaps.
      // Locking, though, ends the current segment: the user stepped away.
      const start = dayStart()
      yield* Ref.update(segments, (items) => {
        // Close any open segment that rolled over from a previous day at
        // midnight. Without this the first probe of the day that matches the
        // carried segment is a no-op and the Gantt shows one long bar spanning
        // the boundary instead of starting today clean.
        const closed = items.map((segment) =>
          segment.end === undefined && segment.start < start ? { ...segment, end: start } : segment,
        )
        const kept = closed.filter((segment) => segment.end === undefined || segment.end >= start)
        const open = kept.find((segment) => segment.end === undefined)
        const app = input.focusApp || ""
        if (open && open.app === app) return kept
        if (!app) {
          if (!input.locked || !open) return kept
          const next = [...kept]
          const index = next.indexOf(open)
          if (index !== -1) next[index] = { ...open, end: now }
          return next
        }
        const next = [...kept]
        if (open) {
          const index = next.indexOf(open)
          if (index !== -1) next[index] = { ...open, end: now }
        }
        next.push({ app, start: now })
        return next.slice(-30)
      })

      // Persist today's segments (delete-then-insert in one transaction) and
      // prune older days so the table never grows unbounded.
      const day = dayKey(start)
      const items = yield* Ref.get(segments)
      yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            yield* tx.delete(PresenceSegmentTable).where(lt(PresenceSegmentTable.day, day)).run()
            yield* tx.delete(PresenceSegmentTable).where(eq(PresenceSegmentTable.day, day)).run()
            if (items.length === 0) return
            yield* tx
              .insert(PresenceSegmentTable)
              .values(
                items.map((segment) => ({
                  day,
                  app: segment.app,
                  start: segment.start,
                  end: segment.end ?? null,
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const timeline = Effect.fn("Presence.timeline")(function* () {
      const items = yield* Ref.get(segments)
      const seen = yield* Ref.get(lastSeen)
      return projectTimeline(items, {
        now: Date.now(),
        dayStart: dayStart(),
        lastSeen: seen,
        staleAfterMs: STALE_AFTER_MS,
      })
    })

    return Service.of({ get, update, timeline })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as Presence from "./index"
