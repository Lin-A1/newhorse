import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { PresenceSegmentTable } from "@newhorse/core/presence/sql"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Presence } from "../../src/presence"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Presence.node, Database.node])))

const todayKey = () => {
  const d = new Date(Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

describe("presence segments", () => {
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
      const context = yield* Layer.build(
        LayerNode.compile(Presence.node, [
          [Database.node, Layer.succeed(Database.Service, database)],
        ]),
      )
      const freshPresence = Context.get(context, Presence.Service)
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
