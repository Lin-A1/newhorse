import { create as createIdentifier } from "@newhorse/schema/identifier"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  memory: "mem",
  memoryEntity: "me",
  memoryHistory: "mh",
  scheduledEvent: "sch",
  scheduledEventAudit: "sha",
  scheduledEventDelivery: "sdl",
  continuityGrant: "cgr",
  continuityGrantAudit: "cga",
  policyAudit: "plc",
  workbenchTodo: "wbt",
} as const

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  return prefix + "_" + createIdentifier(direction === "descending", timestamp)
}

/** Extract timestamp from an ascending ID. Does not work with descending IDs. */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const payload = id.slice(prefix.length + 1)
  // Legacy IDs use a 12-hex time field; current ascending IDs use "z" + 14 hex.
  const marker = payload.startsWith("z") ? 1 : 0
  const hex = payload.slice(marker, marker + (marker ? 14 : 12))
  const encoded = BigInt("0x" + hex)
  return Number(encoded / BigInt(0x1000))
}

export * as Identifier from "./id"
