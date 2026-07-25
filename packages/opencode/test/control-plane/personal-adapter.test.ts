import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { getAdapter, listAdapters } from "../../src/control-plane/adapters"
import {
  PERSONAL_ADAPTER_TYPE,
  isPersonalDirectory,
  personalDirectory,
} from "../../src/control-plane/adapters/personal"

const ROOT = path.join(Global.Path.data, "personal")

describe("personal workspace adapter", () => {
  test("is registered as a builtin adapter", () => {
    expect(getAdapter(ProjectV2.ID.global, PERSONAL_ADAPTER_TYPE).name).toBe("Personal")
    expect(listAdapters(ProjectV2.ID.global).map((x) => x.type)).toContain(PERSONAL_ADAPTER_TYPE)
  })

  test("slugifies names into the personal root", () => {
    expect(personalDirectory("My Journal")).toBe(path.join(ROOT, "my-journal"))
    expect(personalDirectory("  ")).toBe(path.join(ROOT, "default"))
  })

  test("slug cannot escape the personal root", () => {
    expect(personalDirectory("../../etc/passwd")).toBe(path.join(ROOT, "etc-passwd"))
    expect(isPersonalDirectory(personalDirectory("../../etc/passwd"))).toBe(true)
  })

  test("configure resolves directory and clears branch", async () => {
    const adapter = getAdapter(ProjectV2.ID.global, PERSONAL_ADAPTER_TYPE)
    const result = await adapter.configure({
      type: PERSONAL_ADAPTER_TYPE,
      name: "Life Admin",
      branch: null,
      directory: "",
      projectID: ProjectV2.ID.global,
    } as any)
    expect(result.directory).toBe(path.join(ROOT, "life-admin"))
    expect(result.branch).toBeNull()
  })

  test("configure rejects a directory outside the personal root", async () => {
    const adapter = getAdapter(ProjectV2.ID.global, PERSONAL_ADAPTER_TYPE)
    await expect(
      adapter.configure({
        type: PERSONAL_ADAPTER_TYPE,
        name: "escape",
        branch: null,
        directory: "/tmp/not-personal",
        projectID: ProjectV2.ID.global,
      } as any),
    ).rejects.toThrow(/must stay under/)
  })

  test("isPersonalDirectory only matches the personal root", () => {
    expect(isPersonalDirectory(path.join(ROOT, "journal"))).toBe(true)
    expect(isPersonalDirectory(ROOT)).toBe(true)
    expect(isPersonalDirectory("/home/lin/work/code/project")).toBe(false)
    expect(isPersonalDirectory(ROOT + "-sneaky")).toBe(false)
  })
})
