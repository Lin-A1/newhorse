import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { SessionTable } from "@newhorse/core/session/sql"
import { desc, eq } from "drizzle-orm"
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
    // Focus-app segments for today (local day). Reset on day rollover.
    const segments = yield* Ref.make<Segment[]>([])

    const dayStart = () => {
      const d = new Date(Date.now())
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }

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
      return {
        idleMs: Math.max(0, now - lastActivity),
        locked: reported?.locked ?? false,
        focusApp: reported?.focusApp,
        inMeeting: reported?.inMeeting ?? false,
        observedAt: reported?.observedAt ?? now,
      } satisfies Info
    })

    const update = Effect.fn("Presence.update")(function* (input: Extras) {
      const now = Date.now()
      yield* Ref.set(extras, { ...input, observedAt: now })

      // Grow the focus-app Gantt: close the previous segment at `now` when the
      // app changed, then start/keep the current app's segment. Segments older
      // than today are dropped (the panel only shows the current day).
      const start = dayStart()
      yield* Ref.update(segments, (items) => {
        const kept = items.filter((segment) => segment.end === undefined || segment.end >= start)
        const open = kept.find((segment) => segment.end === undefined)
        const app = input.focusApp || ""
        if (open && open.app === app) return kept
        const next = [...kept]
        if (open) {
          const index = next.indexOf(open)
          if (index !== -1) next[index] = { ...open, end: now }
        }
        if (app) next.push({ app, start: now })
        return next.slice(-30)
      })
    })

    const timeline = Effect.fn("Presence.timeline")(function* () {
      const start = dayStart()
      const now = Date.now()
      const items = yield* Ref.get(segments)
      const kept = items.filter((segment) => (segment.end ?? now) >= start)
      // A single live segment (end undefined) means the host is active right now.
      const live = kept.some((segment) => segment.end === undefined)
      return {
        segments: [...kept].reverse(),
        live,
      } satisfies Timeline
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
