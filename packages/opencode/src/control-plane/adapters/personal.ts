import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Global } from "@newhorse/core/global"
import { FSUtil } from "@newhorse/core/fs-util"
import { ProjectV2 } from "@newhorse/core/project"
import { type WorkspaceAdapter, WorkspaceInfo } from "../types"

const PersonalConfig = Schema.Struct({
  name: WorkspaceInfo.fields.name,
  directory: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodePersonalConfig = Schema.decodeUnknownSync(PersonalConfig)

export const PERSONAL_ADAPTER_TYPE = "personal"

const ROOT = path.join(Global.Path.data, "personal")

// Personal spaces live outside any repo, so the slug is the only thing
// standing between a workspace name and an arbitrary filesystem write.
function slugify(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return slug || "default"
}

export function personalDirectory(name: string) {
  return path.join(ROOT, slugify(name))
}

export function isPersonalDirectory(directory: string) {
  return FSUtil.contains(FSUtil.resolve(ROOT), FSUtil.resolve(directory))
}

function resolveDirectory(info: WorkspaceInfo) {
  const config = decodePersonalConfig(info)
  const directory = config.directory?.trim() ? config.directory : personalDirectory(config.name)
  const resolved = FSUtil.resolve(directory)
  if (!FSUtil.contains(FSUtil.resolve(ROOT), resolved)) {
    throw new Error(`Personal workspace directory must stay under ${ROOT}`)
  }
  return resolved
}

export const PersonalAdapter: WorkspaceAdapter = {
  name: "Personal",
  description: "A personal space outside any code project",
  async configure(info) {
    const directory = resolveDirectory(info)
    return {
      ...info,
      name: info.name || path.basename(directory),
      branch: null,
      directory,
    }
  },
  async create(info) {
    const directory = resolveDirectory(info)
    await Promise.all(
      ["files", "notes", "output", "tmp"].map((name) => fs.mkdir(path.join(directory, name), { recursive: true })),
    )
  },
  async list() {
    const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        type: PERSONAL_ADAPTER_TYPE,
        name: entry.name,
        branch: null,
        directory: path.join(ROOT, entry.name),
        projectID: ProjectV2.ID.global,
      }))
  },
  async remove() {
    // Personal spaces hold user-authored content, so removing the workspace
    // record must never delete the directory.
  },
  target(info) {
    return {
      type: "local",
      directory: resolveDirectory(info),
    }
  },
}
