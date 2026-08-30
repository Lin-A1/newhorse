import { describe, expect, it } from "bun:test"
import { createSkillTool } from "./skill"
import type { SkillDisclosure } from "@newhorse/plugin"

const skills: SkillDisclosure[] = [
  { name: "review", description: "Review code", body: "---\nname: review\ndescription: Review code\n---\nYou are a strict reviewer.", path: "skills/review/SKILL.md" },
  { name: "plan", description: "Plan work", body: "Plan body", path: "skills/plan.md" },
]

describe("skill tool (three-level disclosure)", () => {
  it("with no args returns the light catalog (name + description only)", async () => {
    const tool = createSkillTool(async () => skills)
    const res = await tool.execute({}, undefined)
    const out = res as { skills?: { name: string; body?: string }[] }
    expect(out.skills?.length).toBe(2)
    expect(out.skills![0]!.body).toBeUndefined() // no body leaked in the catalog
  })

  it("level 1: name only returns metadata + a hint, not the body", async () => {
    const tool = createSkillTool(async () => skills)
    const res = await tool.execute({ name: "review" }, undefined)
    const out = res as { body?: string; hint?: string }
    expect(out.body).toBeUndefined()
    expect(out.hint).toContain("load: true")
  })

  it("level 2: load:true returns the SKILL.md body", async () => {
    const tool = createSkillTool(async () => skills)
    const res = await tool.execute({ name: "review", load: true }, undefined)
    const out = res as { body?: string }
    expect(out.body).toContain("strict reviewer")
  })

  it("unknown name errors with the available catalog", async () => {
    const tool = createSkillTool(async () => skills)
    const res = await tool.execute({ name: "none" }, undefined)
    const out = res as { error?: string; available?: string[] }
    expect(out.error).toContain("not found")
    expect(out.available).toEqual(["review", "plan"])
  })
})
