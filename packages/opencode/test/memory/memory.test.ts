import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { Memory, detectSensitive } from "@/memory"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Memory.node))

describe("Memory", () => {
  it.instance("stores explicit memory as active", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "preference",
        content: "prefers dark mode",
        provenance: "user_explicit",
      })

      expect(saved.status).toBe("active")
      expect(saved.scope).toBe("workspace")
      expect(saved.id.startsWith("mem_")).toBe(true)
    }),
  )

  // Inference must never become an asserted fact on its own.
  it.instance("stores inferred memory as a proposal only", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "fact",
        content: "probably lives in Berlin",
        provenance: "model_inferred",
      })

      expect(saved.status).toBe("proposed")

      const retrieved = yield* memory.retrieve()
      expect(retrieved.find((item) => item.id === saved.id)).toBeUndefined()
    }),
  )

  it.instance("promotes a proposal once accepted", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "fact",
        content: "uses pnpm",
        provenance: "model_inferred",
      })
      yield* memory.setStatus({ id: saved.id, status: "active" })

      const retrieved = yield* memory.retrieve()
      expect(retrieved.some((item) => item.id === saved.id)).toBe(true)
    }),
  )

  it.instance("refuses to store credentials", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const exit = yield* memory
        .save({
          kind: "fact",
          content: "my api key is sk-abcdef0123456789ghijkl",
          provenance: "user_explicit",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* memory.list()).toEqual([])
    }),
  )

  it.instance("forgotten memory is no longer retrievable", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const saved = yield* memory.save({
        kind: "goal",
        content: "learn Rust",
        provenance: "user_explicit",
      })
      yield* memory.forget(saved.id)

      expect(yield* memory.list()).toEqual([])
      expect(yield* memory.retrieve()).toEqual([])
    }),
  )

  it.instance("expired memory is not retrieved", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({
        kind: "event",
        content: "standup at 10",
        provenance: "user_explicit",
        expiresAt: Date.now() - 1000,
      })

      expect(yield* memory.retrieve()).toEqual([])
      expect((yield* memory.list()).length).toBe(1)
    }),
  )

  it.instance("clear removes workspace memory but keeps user_global preferences", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.save({ kind: "fact", content: "workspace scoped", provenance: "user_explicit" })
      const global = yield* memory.save({
        kind: "preference",
        content: "answers in Chinese",
        provenance: "user_explicit",
        scope: "user_global",
      })

      yield* memory.clear()

      const remaining = yield* memory.list()
      expect(remaining.map((item) => item.id)).toEqual([global.id])
    }),
  )
})

describe("detectSensitive", () => {
  it.effect("flags credentials and payment data", () =>
    Effect.sync(() => {
      expect(detectSensitive("token: hunter2")).toBe(true)
      expect(detectSensitive("ghp_abcdefghijklmnopqrstuvwxyz12")).toBe(true)
      expect(detectSensitive("AKIAIOSFODNN7EXAMPLE")).toBe(true)
      expect(detectSensitive("4111 1111 1111 1111")).toBe(true)
      expect(detectSensitive("-----BEGIN RSA PRIVATE KEY-----")).toBe(true)
    }),
  )

  it.effect("leaves ordinary notes alone", () =>
    Effect.sync(() => {
      expect(detectSensitive("prefers dark mode")).toBe(false)
      expect(detectSensitive("buy oat milk on the way home")).toBe(false)
    }),
  )
})
