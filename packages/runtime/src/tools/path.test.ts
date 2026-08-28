import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { resolveInWorkspace } from "./path"

async function workspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "nh-ws-"))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("resolveInWorkspace sandbox", () => {
  it("resolves a path inside the workspace", async () => {
    const { root, cleanup } = await workspace()
    try {
      const r = await resolveInWorkspace(root, "src/f.ts")
      expect(r.startsWith(root)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it("resolves the workspace root itself", async () => {
    const { root, cleanup } = await workspace()
    try {
      const r = await resolveInWorkspace(root, ".")
      expect(r).toBe(root)
    } finally {
      await cleanup()
    }
  })

  it("rejects a sibling-prefix path (G:\\repo vs G:\\repo-evil)", async () => {
    const { root, cleanup } = await workspace()
    try {
      // A directory that shares the root's basename as a prefix (repo vs
      // repo-evil). A naive `startsWith(root)` would wrongly admit it.
      const evil = join(dirname(root), basename(root) + "-evil")
      await mkdir(evil).catch(() => {})
      await expect(resolveInWorkspace(root, "../" + basename(evil) + "/x.txt")).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it("rejects an upward traversal with ..", async () => {
    const { root, cleanup } = await workspace()
    try {
      await expect(resolveInWorkspace(root, "../../secret.txt")).rejects.toThrow()
      await expect(resolveInWorkspace(root, "../")).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it("rejects an absolute path outside the workspace", async () => {
    const { root, cleanup } = await workspace()
    try {
      await expect(resolveInWorkspace(root, join(tmpdir(), "other"))).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it("rejects an empty or missing path", async () => {
    const { root, cleanup } = await workspace()
    try {
      await expect(resolveInWorkspace(root, "")).rejects.toThrow()
      await expect(resolveInWorkspace(root, undefined as never)).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it("follows a symlink that escapes the workspace and rejects it", async () => {
    const { root, cleanup } = await workspace()
    const outside = await mkdtemp(join(tmpdir(), "nh-out-"))
    try {
      await writeFile(join(outside, "secret.txt"), "secret")
      const link = join(root, "link")
      await symlink(outside, link, "junction").catch(() => {})
      // If symlinking failed (permissions), skip — but on Windows junction works.
      await expect(resolveInWorkspace(root, "link/secret.txt")).rejects.toThrow()
    } finally {
      await cleanup()
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("resolves a write target that does not yet exist (deep path)", async () => {
    const { root, cleanup } = await workspace()
    try {
      const r = await resolveInWorkspace(root, "a/b/c.txt")
      expect(r.startsWith(root)).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
