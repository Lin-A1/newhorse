import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { WorkspaceMetadataRef, type WorkspaceMetadata } from "@/effect/instance-ref"
import { isPersonalDirectory, PERSONAL_ADAPTER_TYPE } from "./adapters/personal"

export const Kind = Schema.Literals(["project", "personal"])
export type Kind = Schema.Schema.Type<typeof Kind>

export const Source = Schema.Literals(["metadata", "legacy-directory"])
export type Source = Schema.Schema.Type<typeof Source>

export const Info = Schema.Struct({
  kind: Kind,
  contentScope: Kind,
  source: Source,
})
export type Info = Schema.Schema.Type<typeof Info>

export function resolve(input: { metadata?: WorkspaceMetadata; directory: string }): Info {
  if (input.metadata) {
    const kind = input.metadata.type === PERSONAL_ADAPTER_TYPE ? "personal" : "project"
    return { kind, contentScope: kind, source: "metadata" }
  }
  const kind = isPersonalDirectory(input.directory) ? "personal" : "project"
  return { kind, contentScope: kind, source: "legacy-directory" }
}

export const current = InstanceState.context.pipe(
  Effect.flatMap((ctx) =>
    Effect.map(WorkspaceMetadataRef, (metadata) => resolve({ metadata, directory: ctx.directory })),
  ),
)

export function allowsPersonalOptIn(policy: Info, optedIn: boolean): boolean {
  return policy.kind === "project" || optedIn
}

export * as WorkspacePolicy from "./workspace-policy"
