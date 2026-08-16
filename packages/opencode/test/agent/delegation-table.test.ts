import { describe, expect, test } from "bun:test"
import { buildAgentGuidance } from "../../src/agent/delegation-table"
import type { Agent } from "../../src/agent/agent"

const agent = (input: Partial<Agent.Info> & { name: string }): Agent.Info => ({
  options: {},
  permission: [],
  mode: "subagent",
  ...input,
})

describe("buildAgentGuidance", () => {
  test("returns undefined when no delegatable agents with triggers exist", () => {
    expect(buildAgentGuidance([])).toBeUndefined()
    expect(
      buildAgentGuidance([
        agent({ name: "build", mode: "primary", subagent_meta: { category: "advisor", cost: "CHEAP" } }),
      ]),
    ).toBeUndefined()
  })

  test("renders the delegation table with domain, agent, and trigger", () => {
    const guidance = buildAgentGuidance([
      agent({
        name: "researcher",
        subagent_meta: {
          category: "exploration",
          cost: "CHEAP",
          key_trigger: "需要调研时委派 researcher",
          triggers: [{ domain: "research", trigger: "用户要求调研" }],
        },
      }),
      agent({
        name: "writer",
        subagent_meta: {
          category: "specialist",
          cost: "CHEAP",
          key_trigger: "需要写文档时委派 writer",
          triggers: [{ domain: "writing", trigger: "撰写文档/报告" }],
        },
      }),
    ])!
    expect(guidance).toContain("<available_subagents>")
    expect(guidance).toContain("| Domain | Delegate To | Trigger |")
    expect(guidance).toContain("| research | `researcher` | 用户要求调研 |")
    expect(guidance).toContain("| writing | `writer` | 撰写文档/报告 |")
    expect(guidance).toContain("- 需要调研时委派 researcher")
    expect(guidance).toContain("- 需要写文档时委派 writer")
    expect(guidance).toContain("</available_subagents>")
  })

  test("sorts agents by name for a stable prompt prefix", () => {
    const guidance = buildAgentGuidance([
      agent({
        name: "zebra",
        subagent_meta: { triggers: [{ domain: "z", trigger: "z task" }], cost: "CHEAP", category: "specialist" },
      }),
      agent({
        name: "alpha",
        subagent_meta: { triggers: [{ domain: "a", trigger: "a task" }], cost: "CHEAP", category: "specialist" },
      }),
    ])!
    expect(guidance.indexOf("| a | `alpha` |")).toBeLessThan(guidance.indexOf("| z | `zebra` |"))
  })

  test("mentions plan_enter only when enabled", () => {
    const agents = [
      agent({
        name: "researcher",
        subagent_meta: { triggers: [{ domain: "r", trigger: "r task" }], cost: "CHEAP", category: "exploration" },
      }),
    ]
    expect(buildAgentGuidance(agents)).not.toContain("plan_enter")
    expect(buildAgentGuidance(agents, { planEnter: true })).toContain("plan_enter")
  })

  test("skips hidden and primary agents", () => {
    const guidance = buildAgentGuidance([
      agent({
        name: "hidden_agent",
        hidden: true,
        subagent_meta: { triggers: [{ domain: "h", trigger: "hidden task" }], cost: "CHEAP", category: "specialist" },
      }),
      agent({
        name: "primary_agent",
        mode: "primary",
        subagent_meta: { triggers: [{ domain: "p", trigger: "primary task" }], cost: "CHEAP", category: "advisor" },
      }),
      agent({
        name: "visible_agent",
        subagent_meta: { triggers: [{ domain: "v", trigger: "visible task" }], cost: "CHEAP", category: "specialist" },
      }),
    ])!
    expect(guidance).toContain("visible_agent")
    expect(guidance).not.toContain("hidden_agent")
    expect(guidance).not.toContain("primary_agent")
  })
})
