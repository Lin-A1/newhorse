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

export interface Interface {
  readonly get: (input: { directory: string }) => Effect.Effect<Info>
  readonly update: (extras: Extras) => Effect.Effect<void>
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
      yield* Ref.set(extras, { ...input, observedAt: Date.now() })
    })

    return Service.of({ get, update })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as Presence from "./index"
