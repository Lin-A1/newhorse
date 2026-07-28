import { expect, test } from "bun:test"
import { Global } from "@newhorse/core/global"
import { ProjectV2 } from "@newhorse/core/project"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import path from "node:path"
import { WorkspacePolicy } from "@/control-plane/workspace-policy"

const personalDirectory = path.join(Global.Path.data, "personal", "notes")
const projectDirectory = path.join(Global.Path.data, "projects", "newhorse")

function metadata(type: string, directory: string) {
  return {
    id: WorkspaceV2.ID.make("wrk_policy"),
    type,
    projectID: ProjectV2.ID.global,
    directory,
  }
}

test("workspace metadata takes precedence over directory inference", () => {
  expect(
    WorkspacePolicy.resolve({ metadata: metadata("worktree", personalDirectory), directory: personalDirectory }),
  ).toEqual({
    kind: "project",
    contentScope: "project",
    source: "metadata",
  })
  expect(
    WorkspacePolicy.resolve({ metadata: metadata("personal", projectDirectory), directory: projectDirectory }),
  ).toEqual({
    kind: "personal",
    contentScope: "personal",
    source: "metadata",
  })
})

test("legacy directory inference remains explicit", () => {
  expect(WorkspacePolicy.resolve({ directory: personalDirectory })).toMatchObject({
    kind: "personal",
    source: "legacy-directory",
  })
  expect(WorkspacePolicy.resolve({ directory: projectDirectory })).toMatchObject({
    kind: "project",
    source: "legacy-directory",
  })
})

test("personal extensions require opt-in without restricting projects", () => {
  const personal = WorkspacePolicy.resolve({
    metadata: metadata("personal", personalDirectory),
    directory: personalDirectory,
  })
  const project = WorkspacePolicy.resolve({
    metadata: metadata("worktree", projectDirectory),
    directory: projectDirectory,
  })

  expect(WorkspacePolicy.allowsPersonalOptIn(personal, false)).toBe(false)
  expect(WorkspacePolicy.allowsPersonalOptIn(personal, true)).toBe(true)
  expect(WorkspacePolicy.allowsPersonalOptIn(project, false)).toBe(true)
})
