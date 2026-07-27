export * as ConfigSkillsV1 from "./skills"

import { Schema } from "effect"

export const Info = Schema.Struct({
  personal: Schema.optional(Schema.Boolean).annotate({
    description: "Allow configured and external skills inside personal workspaces. Defaults to false.",
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
