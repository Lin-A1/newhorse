import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { FSUtil } from "@newhorse/core/fs-util"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { Global } from "@newhorse/core/global"
import { BoulderState } from "@/plan/boulder-state"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { testEffect } from "../lib/effect"
import { requireInstance, testInstanceStoreLayer } from "../fixture/fixture"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])), testInstanceStoreLayer),
)

const ctxOf = (vcs: string | undefined, worktree = "/ws"): InstanceContext =>
  ({ directory: worktree, worktree, project: { vcs } }) as InstanceContext

const planIn = (dir: string) => path.join(dir, ".opencode", "plans", "1700000000000-fix-auth.md")

describe("parsePlanProgress", () => {
  test("returns zero progress for a plan with no checkboxes", () => {
    expect(BoulderState.parsePlanProgress("# Plan\n\nSome prose without tasks")).toEqual({
      total: 0,
      completed: 0,
      isComplete: false,
    })
  })

  test("counts completed and open checkboxes across both bullet styles", () => {
    const md = [
      "# Plan",
      "",
      "- [x] done one",
      "- [X] done two (uppercase)",
      "* [ ] open three (star bullet)",
      "- [ ] open four",
      "- plain list item",
      "inline [ ] is not a checkbox",
    ].join("\n")
    expect(BoulderState.parsePlanProgress(md)).toEqual({ total: 4, completed: 2, isComplete: false })
  })

  test("detects a fully-complete plan", () => {
    const md = ["- [x] a", "- [X] b", "- [x] c"].join("\n")
    expect(BoulderState.parsePlanProgress(md)).toEqual({ total: 3, completed: 3, isComplete: true })
  })

  test("uses a simple line regex (checkbox-like lines count anywhere)", () => {
    const md = ["- [ ] real task", "", "```", "- [x] sample in code", "```"].join("\n")
    expect(BoulderState.parsePlanProgress(md)).toEqual({ total: 2, completed: 1, isComplete: false })
  })
})

describe("statePath", () => {
  test("uses {worktree}/.opencode/boulder.json for VCS projects", () => {
    expect(BoulderState.statePath(ctxOf("git", "C:\\repo"))).toBe(path.join("C:\\repo", ".opencode", "boulder.json"))
  })

  test("falls back to the global data dir for non-VCS projects", () => {
    expect(BoulderState.statePath(ctxOf(undefined))).toBe(path.join(Global.Path.data, "boulder.json"))
  })
})

describe("planName", () => {
  test("extracts the slug from a timestamp-prefixed plan path", () => {
    expect(BoulderState.planName("/ws/.opencode/plans/1700000000000-fix-auth.md")).toBe("fix-auth")
  })

  test("falls back to the basename when there is no timestamp prefix", () => {
    expect(BoulderState.planName("/ws/.opencode/plans/plan.md")).toBe("plan")
  })
})

describe("parseState", () => {
  test("rejects malformed payloads", () => {
    expect(BoulderState.parseState(null)).toBeUndefined()
    expect(BoulderState.parseState("nope")).toBeUndefined()
    expect(BoulderState.parseState({})).toBeUndefined()
    expect(BoulderState.parseState({ active_plan: 42 })).toBeUndefined()
  })

  test("defaults missing optional fields", () => {
    expect(BoulderState.parseState({ active_plan: "/p.md" })).toEqual({
      active_plan: "/p.md",
      started_at: "",
      session_ids: [],
      plan_name: "",
    })
  })
})

describe("resumePrompt", () => {
  test("includes plan name, path, start time and progress", () => {
    const text = BoulderState.resumePrompt({
      planPath: "/ws/.opencode/plans/1700000000000-fix-auth.md",
      planName: "fix-auth",
      startedAt: "2026-01-01T00:00:00.000Z",
      progress: { total: 4, completed: 1, isComplete: false },
    })
    expect(text).toContain("fix-auth")
    expect(text).toContain("/ws/.opencode/plans/1700000000000-fix-auth.md")
    expect(text).toContain("2026-01-01T00:00:00.000Z")
    expect(text).toContain("1/4 checkboxes complete")
  })
})

describe("boulder state lifecycle", () => {
  it.instance("createState persists boulder.json and getState reads it back", () =>
    Effect.gen(function* () {
      const dir = (yield* requireInstance).directory
      const ctx = yield* InstanceState.context
      const plan = planIn(dir)

      yield* BoulderState.createState(ctx, {
        activePlan: plan,
        planName: "fix-auth",
        sessionID: "ses_plan",
        startedAt: "2026-01-01T00:00:00.000Z",
      })

      const state = yield* BoulderState.getState(ctx)
      expect(state).toEqual({
        active_plan: plan,
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["ses_plan"],
        plan_name: "fix-auth",
      })

      const fsys = yield* FSUtil.Service
      const onDisk = yield* fsys.readFileStringSafe(path.join(dir, ".opencode", "boulder.json"))
      expect(onDisk).toContain('"active_plan"')
    }),
    { git: true },
  )

  it.instance("appendSessionId records new sessions and dedupes", () =>
    Effect.gen(function* () {
      const dir = (yield* requireInstance).directory
      const ctx = yield* InstanceState.context
      const plan = planIn(dir)

      yield* BoulderState.createState(ctx, { activePlan: plan, planName: "fix-auth", sessionID: "ses_plan" })
      yield* BoulderState.appendSessionId(ctx, "ses_build")
      yield* BoulderState.appendSessionId(ctx, "ses_build")

      const state = yield* BoulderState.getState(ctx)
      expect(state?.session_ids).toEqual(["ses_plan", "ses_build"])
    }),
    { git: true },
  )

  it.instance("appendSessionId is a no-op when no state exists", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const result = yield* BoulderState.appendSessionId(ctx, "ses_any")
      expect(result).toBeUndefined()
    }),
    { git: true },
  )

  it.instance("getState returns undefined when no state file exists", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      expect(yield* BoulderState.getState(ctx)).toBeUndefined()
    }),
    { git: true },
  )

  it.instance("getPlanProgress reads checkbox progress from a plan file", () =>
    Effect.gen(function* () {
      const dir = (yield* requireInstance).directory
      const fsys = yield* FSUtil.Service
      const plan = planIn(dir)
      yield* fsys.writeWithDirs(plan, ["# Plan", "", "- [x] one", "- [ ] two", "- [x] three"].join("\n"))

      const progress = yield* BoulderState.getPlanProgress(plan)
      expect(progress).toEqual({ total: 3, completed: 2, isComplete: false })
    }),
    { git: true },
  )

  it.instance("clearState removes the state file and reports absence", () =>
    Effect.gen(function* () {
      const dir = (yield* requireInstance).directory
      const ctx = yield* InstanceState.context
      const plan = planIn(dir)

      yield* BoulderState.createState(ctx, { activePlan: plan, planName: "fix-auth", sessionID: "ses_1" })
      expect(yield* BoulderState.clearState(ctx)).toBe(true)
      expect(yield* BoulderState.getState(ctx)).toBeUndefined()
      expect(yield* BoulderState.clearState(ctx)).toBe(false)
    }),
    { git: true },
  )

  it.instance("tracks a plan across sessions and clears when the plan completes", () =>
    Effect.gen(function* () {
      const dir = (yield* requireInstance).directory
      const ctx = yield* InstanceState.context
      const plan = planIn(dir)
      const fsys = yield* FSUtil.Service

      // plan agent records the active plan
      yield* BoulderState.createState(ctx, { activePlan: plan, planName: "fix-auth", sessionID: "ses_plan" })
      // build agent takes over in a later session
      yield* BoulderState.appendSessionId(ctx, "ses_build")

      let state = yield* BoulderState.getState(ctx)
      expect(state?.active_plan).toBe(plan)
      expect(state?.session_ids).toEqual(["ses_plan", "ses_build"])

      // partially executed plan still has state
      yield* fsys.writeWithDirs(plan, ["- [x] a", "- [ ] b"].join("\n"))
      expect(yield* BoulderState.getPlanProgress(plan)).toEqual({ total: 2, completed: 1, isComplete: false })
      expect(yield* BoulderState.getState(ctx)).toBeDefined()

      // all checkboxes ticked -> completion clears the state
      yield* fsys.writeWithDirs(plan, ["- [x] a", "- [x] b"].join("\n"))
      expect((yield* BoulderState.getPlanProgress(plan)).isComplete).toBe(true)
      yield* BoulderState.clearState(ctx)
      expect(yield* BoulderState.getState(ctx)).toBeUndefined()
    }),
    { git: true },
  )
})
