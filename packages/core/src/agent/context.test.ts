import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverWorkspaceContext, composeSystemContext } from "./context"

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nh-ctx-"))
  await mkdir(join(root, "sub", "deep"), { recursive: true })
  await writeFile(join(root, "AGENTS.md"), "root agents\n")
  await writeFile(join(root, "sub", "AGENTS.md"), "sub agents\n")
  await writeFile(join(root, "sub", "deep", "AGENTS.md"), "deep agents\n")
  return join(root, "sub", "deep")
}

describe("workspace context discovery", () => {
  it("discovers AGENTS.md upward from the session to the root, ordered closest-first", async () => {
    const start = await fixture()
    const root = start.replace(/\\sub\\deep$/, "").replace(/\/sub\/deep$/, "")
    try {
      const docs = await discoverWorkspaceContext(start, root)
      expect(docs.length).toBe(3)
      // closest (deep) first
      expect(docs[0]!.text).toContain("deep agents")
      expect(docs[2]!.text).toContain("root agents")
      const composed = composeSystemContext(docs)
      expect(composed.indexOf("deep agents")).toBeLessThan(composed.indexOf("root agents"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns empty when no AGENTS.md exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-ctx-none-"))
    try {
      const docs = await discoverWorkspaceContext(dir, dir)
      expect(docs.length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
