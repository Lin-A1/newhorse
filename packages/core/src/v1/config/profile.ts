export * as ConfigProfileV1 from "./profile"

import { Schema } from "effect"

export const Kind = Schema.Literals(["assistant", "companion"])
export type Kind = Schema.Schema.Type<typeof Kind>

export const MemoryPolicy = Schema.Literals(["off", "ask", "auto-safe"])
export type MemoryPolicy = Schema.Schema.Type<typeof MemoryPolicy>

export const QuietHours = Schema.Struct({
  start: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  end: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  timezone: Schema.String,
})
export type QuietHours = Schema.Schema.Type<typeof QuietHours>

export const ProactiveFrequency = Schema.Struct({
  maxPerDay: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })),
  minIntervalMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
})
export type ProactiveFrequency = Schema.Schema.Type<typeof ProactiveFrequency>

export const Item = Schema.Struct({
  kind: Kind,
  name: Schema.optional(Schema.String),
  persona: Schema.optional(Schema.String),
  personaVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  memory: Schema.optional(MemoryPolicy),
  proactive: Schema.optional(Schema.Boolean),
  proactivePaused: Schema.optional(Schema.Boolean),
  quietHours: Schema.optional(QuietHours),
  proactiveFrequency: Schema.optional(ProactiveFrequency),
  crisisRegion: Schema.optional(Schema.String),
  dailySummary: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ProfileConfig" })
export type Item = Schema.Schema.Type<typeof Item>

export const Info = Schema.Struct({
  active: Schema.optional(Schema.String),
  items: Schema.optional(Schema.Record(Schema.String, Item)),
}).annotate({ identifier: "ProfilesConfig" })
export type Info = Schema.Schema.Type<typeof Info>
