import { afterEach, describe, expect } from "bun:test"
import { Server } from "../../src/server/server"
import { Effect } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

function app() {
  return Server.Default().app
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("presence HttpApi", () => {
  it.live(
    "serves bounded session-derived presence before any desktop report",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/presence", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body).toMatchObject({
        locked: false,
        focusApp: null,
        inMeeting: false,
      })
      expect(typeof body.idleMs).toBe("number")
      expect(typeof body.observedAt).toBe("number")
    }),
  )

  it.live(
    "reports desktop presence and serves it on the next read",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })

      const update = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/presence", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({
              locked: false,
              focusApp: "Code",
              inMeeting: true,
            }),
          }),
        ),
      )
      expect(update.status).toBe(200)

      const current = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/presence", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )
      expect(current.status).toBe(200)
      const body = yield* Effect.promise(() => current.json())
      expect(body).toMatchObject({
        locked: false,
        focusApp: "Code",
        inMeeting: true,
      })
    }),
  )

  it.live(
    "timeline grows one segment per foreground-app switch",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })

      const post = (focusApp: string) =>
        Promise.resolve(
          app().request("/presence", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ locked: false, focusApp, inMeeting: false }),
          }),
        )
      const timeline = () =>
        Effect.promise(() =>
          Promise.resolve(
            app().request("/presence/timeline", {
              headers: { "x-opencode-directory": tmp.path },
            }),
          ),
        )

      expect((yield* Effect.promise(() => post("Code"))).status).toBe(200)
      expect((yield* Effect.promise(() => post("Chrome"))).status).toBe(200)
      expect((yield* Effect.promise(() => post("Chrome"))).status).toBe(200)
      expect((yield* Effect.promise(() => post("Slack"))).status).toBe(200)

      const response = yield* timeline()
      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      const segments: Array<{ app: string; start: number; end?: number }> = body.segments
      expect(segments).toHaveLength(3)
      // Newest first: Slack open, Chrome closed, Code closed.
      expect(segments[0]?.app).toBe("Slack")
      expect(segments[0]?.end).toBeUndefined()
      expect(segments[1]?.app).toBe("Chrome")
      expect(segments[1]?.end).toBeDefined()
      expect(segments[2]?.app).toBe("Code")
      expect(segments[2]?.end).toBeDefined()
      expect(body.live).toBe(true)
    }),
  )
})
