import { describe, expect, test } from "bun:test"
import { defaultProjectDirectory } from "./project-directory"
import type { Project } from "@newhorse/sdk/v2/client"

const project = (worktree: string, updated: number): Project =>
  ({ id: `proj_${worktree}`, worktree, time: { updated, created: updated }, sandboxes: [] }) as Project

describe("defaultProjectDirectory", () => {
  test("prefers a known project worktree", () => {
    expect(
      defaultProjectDirectory({
        known: [{ worktree: "/known" }],
        projects: [project("/server-project", 200)],
        serverDirectory: "/server-cwd",
      }),
    ).toBe("/known")
  })

  test("falls back to the server's most recently used project", () => {
    expect(
      defaultProjectDirectory({
        known: [],
        projects: [project("/older", 100), project("/recent", 300)],
        serverDirectory: "/server-cwd",
      }),
    ).toBe("/recent")
  })

  test("ignores projects without a worktree", () => {
    expect(
      defaultProjectDirectory({
        known: [],
        projects: [{ time: { updated: 100, created: 100 } } as Project, project("/usable", 50)],
        serverDirectory: "/server-cwd",
      }),
    ).toBe("/usable")
  })

  test("falls back to the server default directory", () => {
    expect(
      defaultProjectDirectory({
        known: [],
        projects: [],
        serverDirectory: "/server-cwd",
      }),
    ).toBe("/server-cwd")
  })

  test("returns undefined when the server offers no directory", () => {
    expect(defaultProjectDirectory({ known: [], projects: [] })).toBeUndefined()
  })

  test("treats an empty server directory as absent", () => {
    expect(defaultProjectDirectory({ known: [], projects: [], serverDirectory: "" })).toBeUndefined()
  })
})
