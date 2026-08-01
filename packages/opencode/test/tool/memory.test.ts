import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { SessionProjector } from "@newhorse/core/session/projector"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { SessionV1 } from "@newhorse/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Memory } from "@/memory"
import { Profile } from "@/profile"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { MemoryTool } from "@/tool/memory"
import type * as Tool from "@/tool/tool"
import { WorkspaceMetadataRef } from "@/effect/instance-ref"
import { ProjectV2 } from "@newhorse/core/project"
import { ModelV2 } from "@newhorse/core/model"
import { ProviderV2 } from "@newhorse/core/provider"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Memory.node, Session.node, SessionProjector.node, Profile.node, Truncate.node, Agent.node]),
  ),
)

const personal = {
  id: WorkspaceV2.ID.make("wrk_memory_tool"),
  type: "personal" as const,
  projectID: ProjectV2.ID.global,
}

describe("tool.memory", () => {
  it.instance("creates proposals and asks before model mutations", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const memory = yield* Memory.Service
      const session = yield* sessions.create({ workspaceID: personal.id, profileID: Profile.ID.make("companion") })
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)
      const info = yield* MemoryTool
      const tool = yield* info.init()
      const asked: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx = {
        sessionID: session.id,
        messageID,
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (request) => Effect.sync(() => void asked.push(request)),
      } satisfies Tool.Context

      const saved = yield* tool.execute(
        { action: "save", content: "probably prefers concise replies", kind: "preference" },
        ctx,
      )
      expect(saved).toMatchObject({ title: "Memory proposed", metadata: { status: "proposed" } })
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "memory" })
      expect(yield* memory.retrieve({ profileID: "companion" })).toEqual([])

      const listed = yield* tool.execute({ action: "list" }, ctx)
      expect(listed.output).toContain("probably prefers concise replies")
      expect(asked).toHaveLength(1)
    }).pipe(Effect.provideService(WorkspaceMetadataRef, personal)),
  )

  it.instance("forgets user-global preferences only with explicit scope", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const memory = yield* Memory.Service
      const session = yield* sessions.create({ workspaceID: personal.id, profileID: Profile.ID.make("companion") })
      const preference = yield* memory.save({
        kind: "preference",
        content: "answers concisely",
        provenance: "user_explicit",
        scope: "user_global",
      })
      const info = yield* MemoryTool
      const tool = yield* info.init()
      const asked: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const result = yield* tool.execute(
        { action: "forget", id: preference.id, scope: "user_global" },
        {
          sessionID: session.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (request) => Effect.sync(() => void asked.push(request)),
        },
      )

      expect(result.title).toBe("Memory forgotten")
      expect(asked[0]?.metadata).toMatchObject({
        id: preference.id,
        action: "forget",
        scope: "user_global",
      })
      expect(yield* memory.list({ includeGlobal: true })).toEqual([])
    }).pipe(Effect.provideService(WorkspaceMetadataRef, personal)),
  )

  it.instance("cannot forget relationship Memory owned by another Profile", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const memory = yield* Memory.Service
      const session = yield* sessions.create({ workspaceID: personal.id, profileID: Profile.ID.make("companion") })
      const other = yield* memory.save({
        kind: "relationship",
        content: "assistant relationship",
        provenance: "user_explicit",
        profileID: "assistant",
      })
      const info = yield* MemoryTool
      const tool = yield* info.init()
      const error = yield* tool
        .execute(
          { action: "forget", id: other.id },
          {
            sessionID: session.id,
            messageID: MessageID.ascending(),
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(`Memory not found: ${other.id}`)
      expect((yield* memory.list({ profileID: "assistant" })).map((item) => item.id)).toContain(other.id)
    }).pipe(Effect.provideService(WorkspaceMetadataRef, personal)),
  )
})
