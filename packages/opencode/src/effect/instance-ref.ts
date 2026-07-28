import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@newhorse/core/workspace"
import type { ProjectV2 } from "@newhorse/core/project"

export interface WorkspaceMetadata {
  readonly id: WorkspaceV2.ID
  readonly type: string
  readonly projectID: ProjectV2.ID
  readonly directory?: string | null
}

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~opencode/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~opencode/WorkspaceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceMetadataRef = Context.Reference<WorkspaceMetadata | undefined>("~opencode/WorkspaceMetadataRef", {
  defaultValue: () => undefined,
})
