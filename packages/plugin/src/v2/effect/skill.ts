import type { SkillV2Source } from "@newhorse/sdk/v2/types"
import type { Hooks } from "./registration.js"

type DeepReadonly<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

export interface SkillDraft {
  source(source: DeepReadonly<SkillV2Source>): void
  list(): readonly DeepReadonly<SkillV2Source>[]
}

export type SkillHooks = Hooks<{
  transform: SkillDraft
}>
