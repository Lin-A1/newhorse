import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Profile } from "../../src/profile"
import { MoveSession } from "@newhorse/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const assistantID = Profile.ID.make("assistant")
const companionID = Profile.ID.make("companion")
let activeProfile = assistantID
const profiles = [
  { id: assistantID, kind: "assistant" as const, name: "Assistant", memory: "ask" as const, proactive: false },
  { id: companionID, kind: "companion" as const, name: "Anchor", memory: "auto-safe" as const, proactive: false },
]
let companionRuntime: Profile.Runtime = {
  ...profiles[1],
  persona: "Warm and concise",
  personaVersion: 1,
  proactivePaused: false,
  proactiveFrequency: { maxPerDay: 3, minIntervalMinutes: 120 },
  crisisRegion: "CN",
  dailySummary: true,
}

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(
    Layer.mock(Profile.Service)({
      list: () => Effect.succeed(profiles),
      get: (id) => {
        const result = profiles.find((item) => item.id === (id ?? activeProfile))
        return result
          ? Effect.succeed(result)
          : Effect.fail(new Profile.NotFoundError({ profileID: id ?? assistantID, message: "not found" }))
      },
      activeID: () => Effect.succeed(activeProfile),
      runtime: (id) => {
        if ((id ?? activeProfile) === companionID) return Effect.succeed(companionRuntime)
        if ((id ?? activeProfile) === assistantID) {
          return Effect.succeed({
            ...profiles[0],
            personaVersion: 1,
            proactivePaused: false,
            proactiveFrequency: { maxPerDay: 3, minIntervalMinutes: 120 },
            dailySummary: true,
          })
        }
        return Effect.fail(new Profile.NotFoundError({ profileID: id ?? assistantID, message: "not found" }))
      },
      select: (id) => {
        const result = profiles.find((item) => item.id === id)
        if (!result) return Effect.fail(new Profile.NotFoundError({ profileID: id, message: "not found" }))
        activeProfile = id
        return Effect.succeed(result)
      },
      update: (id, input) => {
        if (id !== companionID) {
          return Effect.fail(new Profile.NotFoundError({ profileID: id, message: "not found" }))
        }
        companionRuntime = {
          ...companionRuntime,
          persona: input.persona ?? companionRuntime.persona,
          memory: input.memory ?? companionRuntime.memory,
          crisisRegion: input.crisisRegion ?? companionRuntime.crisisRegion,
        }
        return Effect.succeed(companionRuntime)
      },
    }),
  ),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("lists and selects redacted profiles", () =>
    Effect.gen(function* () {
      activeProfile = assistantID
      const initial = yield* HttpClient.get(GlobalPaths.profile)
      expect(initial.status).toBe(200)
      expect(yield* initial.json).toEqual({ active: assistantID, items: profiles })

      const selected = yield* HttpClientRequest.patch(GlobalPaths.profile).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ id: companionID })),
        HttpClient.execute,
      )
      expect(selected.status).toBe(200)
      expect(yield* selected.json).toEqual({ active: companionID, items: profiles })
    }),
  )

  it.live("reads companion runtime without fetching global configuration", () =>
    Effect.gen(function* () {
      companionRuntime = { ...companionRuntime, persona: "Warm and concise", memory: "ask", crisisRegion: "CN" }
      const response = yield* HttpClient.get(GlobalPaths.profileRuntime.replace(":profileID", companionID))

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        id: companionID,
        persona: "Warm and concise",
        memory: "ask",
        crisisRegion: "CN",
      })
    }),
  )

  it.live("updates companion runtime without exposing persona in profile state", () =>
    Effect.gen(function* () {
      companionRuntime = { ...companionRuntime, persona: "Warm and concise", memory: "ask", crisisRegion: "CN" }
      const response = yield* HttpClientRequest.patch(
        GlobalPaths.profileUpdate.replace(":profileID", companionID),
      ).pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({ persona: "Calm and direct", memory: "auto-safe", crisisRegion: "SG" }),
        ),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        id: companionID,
        persona: "Calm and direct",
        memory: "auto-safe",
        crisisRegion: "SG",
      })
      expect(JSON.stringify(profiles)).not.toContain("Calm and direct")
    }),
  )

  it.live("rejects unknown profile updates", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch(GlobalPaths.profileUpdate.replace(":profileID", "missing")).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ persona: "ignored" })),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unknown profile selection", () =>
    Effect.gen(function* () {
      activeProfile = assistantID
      const response = yield* HttpClientRequest.patch(GlobalPaths.profile).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ id: Profile.ID.make("missing") })),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
      expect(activeProfile).toBe(assistantID)
    }),
  )

  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )
})
