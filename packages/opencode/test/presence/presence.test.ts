import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { PresenceSegmentTable } from "@newhorse/core/presence/sql"
import { Context, Effect, Layer } from "effect"
import * as LayerNS from "effect/Layer"
import * as Scope from "effect/Scope"
import { eq } from "drizzle-orm"
import { Presence } from "../../src/presence"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Presence.node, Database.node])))

// Build a genuinely fresh Presence service on top of the given Database. A plain
// Layer.build inside a test reuses the runtime's memoized instance, so the seed
// would never re-read the DB; an explicit fresh memo map forces a real rebuild.
const buildFreshPresence = (database: Database.Interface) =>
  Effect.gen(function* () {
    const memoMap = yield* LayerNS.makeMemoMap
    const scope = yield* Scope.Scope
    const context = yield* LayerNS.buildWithMemoMap(
      LayerNode.compile(Presence.node, [
        [Database.node, Layer.succeed(Database.Service, database)],
      ]),
      memoMap,
      scope,
    )
    return Context.get(context, Presence.Service)
  })

const todayKey = () => {
  const d = new Date(Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const dayStart = () => {
  const d = new Date(Date.now())
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

describe("presence segments", () => {
  it.instance("closes the previous app's segment and opens the next on a switch", () =>
    Effect.gen(function* () {
      const presence = yield* Presence.Service
      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })
      yield* presence.update({ locked: false, focusApp: "vscode", inMeeting: false })

      const timeline = yield* presence.timeline()
      expect(timeline.segments).toHaveLength(2)
      expect(timeline.segments.find((s) => s.app === "chrome")?.end).toBeDefined()
      expect(timeline.segments.find((s) => s.app === "vscode")?.end).toBeUndefined()
    }),
  )

  it.instance("the same app is a no-op that keeps the open segment open", () =>
    Effect.gen(function* () {
      const presence = yield* Presence.Service
      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })
      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })

      const timeline = yield* presence.timeline()
      expect(timeline.segments).toHaveLength(1)
      expect(timeline.segments[0]?.app).toBe("chrome")
      expect(timeline.segments[0]?.end).toBeUndefined()
      expect(timeline.live).toBe(true)
    }),
  )

  it.instance("an open segment from a previous day is closed at midnight on the next update", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const midnight = dayStart()
      yield* database.db
        .insert(PresenceSegmentTable)
        .values({ day: todayKey(), app: "yesterday-app", start: midnight - 3 * 60 * 60 * 1000, end: null })
        .run()
        .pipe(Effect.orDie)

      // Build a genuinely fresh service so the stale open row is seeded from the DB.
      const presence = yield* buildFreshPresence(database)
      yield* presence.update({ locked: false, focusApp: "today-app", inMeeting: false })

      const timeline = yield* presence.timeline()
      expect(timeline.segments).toHaveLength(2)
      const carried = timeline.segments.find((s) => s.app === "yesterday-app")
      expect(carried?.end).toBe(midnight)
      expect(timeline.segments.find((s) => s.app === "today-app")?.end).toBeUndefined()
    }),
  )

  it.instance("persists segments to the DB on update", () =>
    Effect.gen(function* () {
      const presence = yield* Presence.Service
      const { db } = yield* Database.Service

      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })
      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })
      yield* presence.update({ locked: false, focusApp: "vscode", inMeeting: false })

      const rows = yield* db
        .select()
        .from(PresenceSegmentTable)
        .where(eq(PresenceSegmentTable.day, todayKey()))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(2)
      expect(rows[0]?.app).toBe("chrome")
      expect(rows[0]?.end).toBeDefined()
      expect(rows[1]?.app).toBe("vscode")
      expect(rows[1]?.end).toBeNull()
    }),
  )

  it.instance("a fresh service build reads persisted segments before any update", () =>
    Effect.gen(function* () {
      const presence = yield* Presence.Service
      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })
      yield* presence.update({ locked: false, focusApp: "vscode", inMeeting: false })

      const database = yield* Database.Service
      const freshPresence = yield* buildFreshPresence(database)
      const timeline = yield* freshPresence.timeline()
      expect(timeline.segments).toHaveLength(2)
      expect(timeline.segments[0]?.app).toBe("vscode")
      expect(timeline.segments[0]?.end).toBeUndefined()
      expect(timeline.segments[1]?.app).toBe("chrome")
      expect(timeline.live).toBe(true)
    }),
  )

  it.instance("an unknown focusApp does not fragment the open segment", () =>
    Effect.gen(function* () {
      const presence = yield* Presence.Service
      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })
      // Failed/empty probe readings must not close the running segment.
      yield* presence.update({ locked: false, focusApp: "", inMeeting: false })
      yield* presence.update({ locked: false, inMeeting: false })

      const timeline = yield* presence.timeline()
      expect(timeline.segments).toHaveLength(1)
      expect(timeline.segments[0]?.app).toBe("chrome")
      expect(timeline.segments[0]?.end).toBeUndefined()
      expect(timeline.live).toBe(true)
    }),
  )

  it.instance("locking closes the open segment without opening a new one", () =>
    Effect.gen(function* () {
      const presence = yield* Presence.Service
      yield* presence.update({ locked: false, focusApp: "chrome", inMeeting: false })
      yield* presence.update({ locked: true, focusApp: "", inMeeting: false })

      const timeline = yield* presence.timeline()
      expect(timeline.segments).toHaveLength(1)
      expect(timeline.segments[0]?.app).toBe("chrome")
      expect(timeline.segments[0]?.end).toBeDefined()
      expect(timeline.live).toBe(false)
    }),
  )
})
