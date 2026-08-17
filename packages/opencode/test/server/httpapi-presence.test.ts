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
})
