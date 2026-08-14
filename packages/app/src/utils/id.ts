const prefixes = {
  session: "ses",
  message: "msg",
  permission: "per",
  user: "usr",
  part: "prt",
  pty: "pty",
} as const

const LENGTH = 26
// Legacy IDs packed a timestamp into a 6-byte (48-bit) field, which rolled over
// every ~795 days (most recently 2026-08-14T11:19:55Z) and made post-rollover IDs
// string-sort before older ones. Current IDs use a 7-byte time field that holds a
// full timestamp until the year ~2527. Ascending IDs additionally carry a leading
// "z" (the largest base62 char) so they string-sort after every legacy ID, keeping
// ID-ordered collections correct when old and new IDs share a store.
const TIME_BYTES = 7
const TIME_HEX_CHARS = TIME_BYTES * 2
let lastTimestamp = 0
let counter = 0

type Prefix = keyof typeof prefixes
export namespace Identifier {
  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }
}

function generateID(prefix: Prefix, descending: boolean, given?: string): string {
  if (!given) {
    return create(prefix, descending)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }

  return given
}

function create(prefix: Prefix, descending: boolean, timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }

  counter += 1

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  if (descending) {
    now = ~now
  }

  const timeBytes = new Uint8Array(TIME_BYTES)
  for (let i = 0; i < TIME_BYTES; i += 1) {
    timeBytes[i] = Number((now >> BigInt((TIME_BYTES - 1) * 8 - 8 * i)) & BigInt(0xff))
  }

  return (
    prefixes[prefix] +
    "_" +
    (descending ? "" : "z") +
    bytesToHex(timeBytes) +
    randomBase62(LENGTH - TIME_HEX_CHARS - (descending ? 0 : 1))
  )
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = getRandomBytes(length)
  let result = ""
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % 62]
  }
  return result
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes)
    return bytes
  }

  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256)
  }

  return bytes
}
