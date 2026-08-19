// End-to-end: a real prompt through the production instance HTTP routes must
// publish session.status busy (and idle) onto the /event SSE stream the app
// subscribes to. This is the definitive check that the "thinking" indicator
// data reaches the app transport, not just the in-process bus.
import { afterEach, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { Ripgrep } from "@newhorse/core/ripgrep"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Session } from "@/session/session"
import { Workspace } from "../../src/control-plane/workspace"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Database } from "@newhorse/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

// The SSE transport can coalesce several `data:` frames into one chunk (and
// emits `: heartbeat` comment frames), so buffer and split on frame boundaries
// instead of assuming one JSON object per chunk.
function makeSseReader(reader: Queue.Dequeue<Uint8Array>) {
  let buffer = ""
  const nextFrame = (input: string): { event: Schema.Schema.Type<typeof EventData>; rawEnd: number } | undefined => {
    const end = input.indexOf("\n\n")
    if (end === -1) return
    const data = input
      .slice(0, end)
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
    if (!data) return { event: undefined as never, rawEnd: end + 2 }
    return { event: Schema.decodeUnknownSync(EventData)(JSON.parse(data)), rawEnd: end + 2 }
  }
  return Effect.fnUntraced(function* () {
    while (true) {
      const found = nextFrame(buffer)
      if (found) {
        buffer = buffer.slice(found.rawEnd)
        if (found.event) return found.event
        continue
      }
      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for event")),
        }),
      )
      buffer += new TextDecoder().decode(value)
    }
  })
}

it.instance(
  "a prompt run streams session.status busy then idle onto the /event SSE stream",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const llm = yield* TestLLMServer

      yield* llm.hang
      const reader = yield* Queue.unbounded<Uint8Array>()

      // Open the app's event transport before the run starts, exactly like the
      // app does, so no event is missed.
      const response = yield* request(`${EventPaths.event}?directory=${encodeURIComponent(test.directory)}`)
      expect(response.status).toBe(200)
      yield* response.stream.pipe(
        Stream.runForEach((value) => Queue.offer(reader, value)),
        Effect.forkScoped,
      )
      const readEvent = makeSseReader(reader)
      expect((yield* readEvent()).type).toBe("server.connected")

      // Point the instance config at the mock LLM so the run resolves the model.
      const config = testProviderConfig(llm.url)
      yield* Effect.promise(() => Bun.write(`${test.directory}/opencode.json`, JSON.stringify(config)))
      const headers = { "x-opencode-directory": test.directory }

      const created = yield* request(SessionPaths.create, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title: "status e2e" }),
      })
      expect(created.status).toBe(200)
      const sessionInfo = (yield* created.json) as { id: string }
      expect((yield* readEvent()).type).toBe("session.created")

      const promptPath = `${SessionPaths.promptAsync.replace(":sessionID", sessionInfo.id)}?directory=${encodeURIComponent(test.directory)}`
      const sendPrompt = request(promptPath, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "hi" }],
        }),
      })
      // promptAsync forks the run server-side and returns immediately; the run
      // hangs at the mock LLM, so watch the SSE stream for the busy window.
      const promptResponse = yield* sendPrompt
      expect(promptResponse.status).toBe(204)

      // busy must arrive while the run is still active.
      const seen: string[] = []
      const busy = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* readEvent()
          seen.push(event.type)
          if (event.type === "session.status") {
            const props = event.properties as { status?: { type?: string }; sessionID?: string }
            if (props.status?.type === "busy") return event
          }
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(new Error(`session.status busy never reached the SSE stream; saw [${seen.join(", ")}]`)),
        }),
      )
      expect(busy.type).toBe("session.status")

      // Cancel the run; the runner's onIdle must publish the terminal idle.
      const abort = yield* request(`${SessionPaths.abort.replace(":sessionID", sessionInfo.id)}?directory=${encodeURIComponent(test.directory)}`, {
        method: "POST",
        headers,
      })
      expect(abort.status).toBe(200)

      const idle = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* readEvent()
          seen.push(event.type)
          if (event.type === "session.status") {
            const props = event.properties as { status?: { type?: string }; sessionID?: string }
            if (props.status?.type === "idle") return event
          }
          if (event.type === "session.idle") return event
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(new Error(`session.status idle never reached the SSE stream; saw [${seen.join(", ")}]`)),
        }),
      )
      expect(idle.type === "session.idle" || idle.type === "session.status").toBe(true)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  90_000,
)
