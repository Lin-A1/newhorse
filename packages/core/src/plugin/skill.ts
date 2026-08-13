/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeNewhorseContent from "./skill/customize-newhorse.md" with { type: "text" }
import newhorseCapabilitiesContent from "./skill/newhorse-capabilities.md" with { type: "text" }

export const CustomizeNewhorseContent = customizeNewhorseContent
export const NewhorseCapabilitiesContent = newhorseCapabilitiesContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "newhorse-capabilities",
            description:
              "What newhorse is and what it can do. Use when the user asks about the product itself: 'can newhorse do...', 'does newhorse have...', 'what features does newhorse have', or how newhorse differs from OpenCode.",
            location: AbsolutePath.make("/builtin/newhorse-capabilities.md"),
            content: NewhorseCapabilitiesContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-newhorse",
            description:
              "Use ONLY when the user is editing or creating newhorse's own configuration: newhorse.json, newhorse.jsonc, opencode.json or opencode.jsonc (legacy), files under .newhorse/ or .opencode/ (legacy), or files under ~/.config/newhorse/ or ~/.config/opencode/ (legacy). Also use when creating or fixing newhorse agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring newhorse itself.",
            location: AbsolutePath.make("/builtin/customize-newhorse.md"),
            content: CustomizeNewhorseContent,
          }),
        }),
      )
    })
  }),
})
