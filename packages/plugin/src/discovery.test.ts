import { describe, expect, it } from "bun:test"
import { discoverPlugin, discoverSkills, shellSplit } from "./discovery"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nh-plugin-"))
  await mkdir(join(dir, "agents"), { recursive: true })
  await mkdir(join(dir, "commands"), { recursive: true })
  await mkdir(join(dir, "hooks"), { recursive: true })
  await mkdir(join(dir, "tools"), { recursive: true })
  await writeFile(join(dir, "agents", "explore.md"), `---\nname: explore\ndescription: A code explorer\nallowed-tools: read, search\nrole: researcher\n---\nYou are a code explorer. Use read and search only.`)
  await writeFile(join(dir, "commands", "plan.md"), `---\nname: plan\ndescription: Make a plan\n---\nDo it`)
  await writeFile(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: [{ name: "validator", event: "pre-tool-use", mode: "command", command: "echo ok" }, { name: "bogus", event: "NotARealEvent" }] }))
  await writeFile(join(dir, "tools", "search.json"), JSON.stringify({ name: "search", description: "search" }))
  return dir
}

describe("directory discovery", () => {
  it("discovers agents, commands, hooks, and tools by convention", async () => {
    const dir = await fixture()
    try {
      const caps = await discoverPlugin(dir)
      const agent = caps.find((c) => c.kind === "agent")
      const command = caps.find((c) => c.kind === "command")
      const tool = caps.find((c) => c.kind === "tool")
      const hooks = caps.filter((c) => c.kind === "hook")
      expect(agent?.name).toBe("explore")
      // Phase 4 agent role fields: body + allowed-tools + role parsed from frontmatter.
      const explore = agent as { body?: string; allowedTools?: string[]; role?: string }
      expect(explore.body).toContain("You are a code explorer")
      expect(explore.allowedTools).toEqual(["read", "search"])
      expect(explore.role).toBe("researcher")
      expect(command?.name).toBe("plan")
      expect(tool?.name).toBe("search")
      // only the whitelisted hook event survives; the bogus one is filtered
      expect(hooks.length).toBe(1)
      expect(hooks[0]?.event).toBe("pre-tool-use")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("discovers skills by convention (folder SKILL.md + flat .md)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-skill-"))
    try {
      await mkdir(join(dir, "skills", "review"), { recursive: true })
      await writeFile(join(dir, "skills", "review", "SKILL.md"), `---\nname: review\ndescription: Review code\n---\nBody`)
      await writeFile(join(dir, "skills", "plan.md"), `---\nname: plan\ndescription: Plan work\n---\nPlan body`)
      const skills = await discoverSkills(dir)
      expect(skills.length).toBe(2)
      const review = skills.find((s) => s.name === "review")
      expect(review?.description).toBe("Review code")
      expect(review?.body).toContain("Body")
      const plan = skills.find((s) => s.name === "plan")
      expect(plan?.body).toContain("Plan body")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("splits hook command lines quote-aware (no broken quoted args)", () => {
    expect(shellSplit("echo ok")).toEqual(["echo", "ok"])
    expect(shellSplit(`rg 'foo bar' src`)).toEqual(["rg", "foo bar", "src"])
    expect(shellSplit(`echo "a b"`)).toEqual(["echo", "a b"])
    expect(shellSplit(`--flag="a b" tail`)).toEqual(["--flag=a b", "tail"])
    expect(shellSplit(`a''b c`)).toEqual(["ab", "c"]) // adjacent quotes concatenate
    expect(shellSplit(`echo 'a "b"'`)).toEqual(["echo", 'a "b"'])
  })
})

describe(".ts tool loading (trust switch)", () => {
  it("skips .ts tools without trust; loads a default-exported Tool with trust", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-ts-tool-"))
    try {
      await mkdir(join(dir, "tools"), { recursive: true })
      await writeFile(join(dir, "tools", "code.ts"), `export default { name: "coded", description: "coded tool", execute: async () => "CODED-RESULT" }`)
      // Untrusted: the .ts definition is NOT loaded.
      const untrusted = await discoverPlugin(dir)
      expect(untrusted.some((c) => c.kind === "tool" && c.name === "coded")).toBe(false)
      // Trusted: it loads and executes.
      const trusted = await discoverPlugin(dir, { trustCode: true })
      const tool = trusted.find((c) => c.kind === "tool" && c.name === "coded") as { execute: (i: unknown, c: unknown) => Promise<unknown> } | undefined
      expect(tool).toBeTruthy()
      expect(await tool!.execute({}, undefined)).toBe("CODED-RESULT")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("command body extraction", () => {
  it("expansion is the body after frontmatter — config never leaks into the prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-cmds-"))
    try {
      await mkdir(join(dir, "commands"), { recursive: true })
      await writeFile(join(dir, "commands", "greet.md"), "---\ndescription: 打招呼\n---\n你好，$ARGUMENTS！", "utf8")
      await writeFile(join(dir, "commands", "bare.md"), "无 frontmatter 的正文", "utf8")
      const caps = await discoverPlugin(dir)
      const isCommand = (name: string) => (c: (typeof caps)[number]): c is Extract<(typeof caps)[number], { kind: "command" }> => c.kind === "command" && c.name === name
      const greet = caps.find(isCommand("greet"))
      const bare = caps.find(isCommand("bare"))
      if (!greet || !bare) throw new Error("commands not discovered")
      const out = (await greet.run([])) as string
      expect(out).toBe("你好，$ARGUMENTS！")
      expect(out.startsWith("---")).toBe(false)
      expect((await bare.run([])) as string).toBe("无 frontmatter 的正文")
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("command body extraction", () => {
  it("runs with args and preserves the body verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-cmds2-"))
    try {
      await mkdir(join(dir, "commands"), { recursive: true })
      await writeFile(join(dir, "commands", "echo.md"), "正文 $ARGUMENTS 结束", "utf8")
      const caps = await discoverPlugin(dir)
      const echo = caps.find((c): c is Extract<(typeof caps)[number], { kind: "command" }> => c.kind === "command" && c.name === "echo")
      if (!echo) throw new Error("not discovered")
      expect((await echo.run(["a b"])) as string).toBe("正文 $ARGUMENTS 结束")
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
