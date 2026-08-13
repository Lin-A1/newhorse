import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { SkillPlugin } from "@newhorse/core/plugin/skill"
import { SkillV2 } from "@newhorse/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in newhorse skills", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-newhorse",
          description: expect.stringContaining("newhorse's own configuration"),
        }),
      )
      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "newhorse-capabilities",
          description: expect.stringContaining("What newhorse is and what it can do"),
        }),
      )
    }),
  )
})
