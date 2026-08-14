import { randomBytes } from "crypto"

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
} as const

const LENGTH = 26

// Legacy IDs packed a timestamp into a 6-byte (48-bit) field, which rolled over
// every ~795 days (most recently 2026-08-14T11:19:55Z) and made post-rollover IDs
// string-sort before older ones. Current IDs use a 7-byte time field that holds a
// full timestamp until the year ~2527. Ascending IDs additionally carry a leading
// "z" (the largest base62 char) so they string-sort after every legacy ID, keeping
// ID-ordered collections correct when old and new IDs share a store.
const timeBytes = 7
const timeHexChars = timeBytes * 2

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

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

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  const timeBytesBuffer = Buffer.alloc(timeBytes)
  for (let i = 0; i < timeBytes; i++) {
    timeBytesBuffer[i] = Number((now >> BigInt((timeBytes - 1) * 8 - 8 * i)) & BigInt(0xff))
  }

  const marker = direction === "descending" ? "" : "z"
  return prefix + "_" + marker + timeBytesBuffer.toString("hex") + randomBase62(LENGTH - timeHexChars - (marker ? 1 : 0))
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
