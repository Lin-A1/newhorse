import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectV2 } from "@newhorse/core/project"
import { containsPath, type InstanceContext } from "@/project/instance-context"

const context = (directory: string): InstanceContext => ({
  directory,
  worktree: directory,
  project: {
    id: ProjectV2.ID.global,
    worktree: directory,
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
})

describe("InstanceContext.containsPath", () => {
  test("accepts normal paths inside the instance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "instance-boundary-"))
    try {
      expect(containsPath(path.join(root, "missing", "file.txt"), context(root))).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("rejects absolute and parent-segment paths outside the instance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "instance-boundary-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "instance-outside-"))
    try {
      expect(containsPath(path.join(outside, "file.txt"), context(root))).toBe(false)
      expect(containsPath(path.join(root, "..", path.basename(outside), "file.txt"), context(root))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  test("rejects symlinks that escape the instance", async () => {
    if (process.platform === "win32") return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "instance-boundary-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "instance-outside-"))
    try {
      await fs.writeFile(path.join(outside, "existing.txt"), "outside")
      await fs.symlink(outside, path.join(root, "escape"))

      expect(containsPath(path.join(root, "escape", "existing.txt"), context(root))).toBe(false)
      expect(containsPath(path.join(root, "escape", "missing", "file.txt"), context(root))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  test("rejects dangling symlinks that escape the instance", async () => {
    if (process.platform === "win32") return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "instance-boundary-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "instance-outside-"))
    try {
      await fs.symlink(path.join(outside, "missing-target"), path.join(root, "escape"))
      expect(containsPath(path.join(root, "escape", "file.txt"), context(root))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  test("accepts internal symlinks", async () => {
    if (process.platform === "win32") return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "instance-boundary-"))
    try {
      const target = path.join(root, "target")
      await fs.mkdir(target)
      await fs.symlink(target, path.join(root, "inside"))
      expect(containsPath(path.join(root, "inside", "missing.txt"), context(root))).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
