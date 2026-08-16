import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { SessionTable } from "@newhorse/core/session/sql"
import { desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

// Bounded, host-owned presence (HANDOFF: no resident daemon). The server
// derives idle time from the most recent session activity in the instance —
// no polling loop, no native hooks. Desktop focus/lock/meeting signals are
// deliberately out of scope here (P1-2 visual/desktop sensing is not adopted).
export const Info = Schema.Struct({
  idleMs: Schema.Number,
  locked: Schema.Boolean,
  focusApp: Schema.optional(Schema.String),
  inMeeting: Schema.Boolean,
  observedAt: Schema.Number,
})
export type Info = Schema.Schema.Type<typeof Info>

export interface Interface {
  readonly get: (input: { directory: string }) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Presence") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

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
      return {
        idleMs: Math.max(0, now - lastActivity),
        locked: false,
        focusApp: undefined,
        inMeeting: false,
        observedAt: now,
      } satisfies Info
    })

    return Service.of({ get })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as Presence from "./index"
