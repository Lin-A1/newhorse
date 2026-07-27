export * as Skill from "./skill"

import { Schema } from "effect"
import { optional } from "./schema"
import { AbsolutePath } from "./schema"

export const ParameterValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
export type ParameterValue = Schema.Schema.Type<typeof ParameterValue>

export const ParameterType = Schema.Literals(["string", "number", "integer", "boolean"])
export type ParameterType = Schema.Schema.Type<typeof ParameterType>

export const Parameter = Schema.Struct({
  type: ParameterType,
  description: Schema.String.pipe(optional),
  required: Schema.Boolean.pipe(optional),
  enum: Schema.Array(ParameterValue).pipe(optional),
  default: ParameterValue.pipe(optional),
})
export type Parameter = Schema.Schema.Type<typeof Parameter>

export const Parameters = Schema.Record(Schema.String, Parameter)
export type Parameters = Schema.Schema.Type<typeof Parameters>

export const Arguments = Schema.Record(Schema.String, ParameterValue)
export type Arguments = Schema.Schema.Type<typeof Arguments>

const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const PARAMETER_TYPES = new Set<ParameterType>(["string", "number", "integer", "boolean"])
const PARAMETER_KEYS = new Set(["type", "description", "required", "enum", "default"])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function matches(type: ParameterType, value: unknown) {
  if (type === "string") return typeof value === "string"
  if (type === "boolean") return typeof value === "boolean"
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  return typeof value === "number" && Number.isFinite(value)
}

export function parseParameters(value: unknown): Parameters | undefined {
  if (value === undefined) return undefined
  if (!record(value)) throw new TypeError("Skill parameters must be an object")

  const output: Record<string, Parameter> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!PARAMETER_NAME.test(name)) throw new TypeError(`Invalid skill parameter name: ${name}`)
    if (!record(raw)) throw new TypeError(`Skill parameter ${name} must be an object`)
    const unknown = Object.keys(raw).find((key) => !PARAMETER_KEYS.has(key))
    if (unknown) throw new TypeError(`Unknown field ${unknown} in skill parameter ${name}`)
    if (!PARAMETER_TYPES.has(raw.type as ParameterType)) {
      throw new TypeError(`Invalid type for skill parameter ${name}`)
    }
    if (raw.description !== undefined && typeof raw.description !== "string") {
      throw new TypeError(`Description for skill parameter ${name} must be a string`)
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      throw new TypeError(`Required for skill parameter ${name} must be a boolean`)
    }

    const type = raw.type as ParameterType
    let values: ParameterValue[] | undefined
    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.some((item) => !matches(type, item))) {
        throw new TypeError(`Enum for skill parameter ${name} must be a non-empty array matching ${type}`)
      }
      values = raw.enum as ParameterValue[]
    }
    if (raw.default !== undefined && !matches(type, raw.default)) {
      throw new TypeError(`Default for skill parameter ${name} must match ${type}`)
    }
    if (raw.default !== undefined && values && !values.includes(raw.default as ParameterValue)) {
      throw new TypeError(`Default for skill parameter ${name} must be one of its enum values`)
    }

    output[name] = {
      type,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      ...(raw.required === undefined ? {} : { required: raw.required }),
      ...(values === undefined ? {} : { enum: values }),
      ...(raw.default === undefined ? {} : { default: raw.default as ParameterValue }),
    }
  }
  return output
}

export function resolveArguments(parameters: Parameters | undefined, value: unknown): Arguments {
  if (value !== undefined && !record(value)) throw new TypeError("Skill arguments must be an object")
  const input = (value ?? {}) as Record<string, unknown>
  const declared = parameters ?? {}
  const unknown = Object.keys(input).find((name) => !(name in declared))
  if (unknown) throw new TypeError(`Unknown skill argument: ${unknown}`)

  const output: Record<string, ParameterValue> = {}
  for (const [name, parameter] of Object.entries(declared)) {
    const supplied = input[name]
    const resolved = supplied === undefined ? parameter.default : supplied
    if (resolved === undefined) {
      if (parameter.required) throw new TypeError(`Missing required skill argument: ${name}`)
      continue
    }
    if (!matches(parameter.type, resolved)) {
      throw new TypeError(`Skill argument ${name} must match ${parameter.type}`)
    }
    if (parameter.enum && !parameter.enum.includes(resolved as ParameterValue)) {
      throw new TypeError(`Skill argument ${name} must be one of: ${parameter.enum.join(", ")}`)
    }
    output[name] = resolved as ParameterValue
  }
  return output
}

export function formatArguments(arguments_: Arguments) {
  if (Object.keys(arguments_).length === 0) return ""
  const json = JSON.stringify(arguments_).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return [
    '<skill_arguments trust="untrusted" encoding="json">',
    json,
    "</skill_arguments>",
  ].join("\n")
}

export interface DirectorySource extends Schema.Schema.Type<typeof DirectorySource> {}
export const DirectorySource = Schema.Struct({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}).annotate({ identifier: "SkillV2.DirectorySource" })

export interface UrlSource extends Schema.Schema.Type<typeof UrlSource> {}
export const UrlSource = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
}).annotate({ identifier: "SkillV2.UrlSource" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  slash: Schema.Boolean.pipe(optional),
  parameters: Parameters.pipe(optional),
  location: AbsolutePath,
  content: Schema.String,
}).annotate({ identifier: "SkillV2.Info" })

export interface EmbeddedSource extends Schema.Schema.Type<typeof EmbeddedSource> {}
export const EmbeddedSource = Schema.Struct({
  type: Schema.Literal("embedded"),
  skill: Schema.suspend(() => Info),
}).annotate({ identifier: "SkillV2.EmbeddedSource" })

export type Source = DirectorySource | UrlSource | EmbeddedSource
export const Source = Object.assign(
  Schema.Union([DirectorySource, UrlSource, EmbeddedSource]).pipe(
    Schema.toTaggedUnion("type"),
    Schema.annotate({ identifier: "SkillV2.Source" }),
  ),
  {
    equals: (a: Source, b: Source) => {
      if (a.type !== b.type) return false
      if (a.type === "directory" && b.type === "directory") return a.path === b.path
      if (a.type === "url" && b.type === "url") return a.url === b.url
      if (a.type === "embedded" && b.type === "embedded") return a.skill.name === b.skill.name
      return false
    },
    key: (source: Source) =>
      source.type === "directory"
        ? `directory:${source.path}`
        : source.type === "url"
          ? `url:${source.url}`
          : `embedded:${source.skill.name}`,
  },
)
