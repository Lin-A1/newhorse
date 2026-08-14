const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

// Legacy IDs packed a timestamp into a 6-byte (48-bit) field, which rolled over
// every ~795 days (most recently 2026-08-14T11:19:55Z) and made post-rollover IDs
// string-sort before older ones. Current IDs use a 7-byte time field that holds a
// full timestamp until the year ~2527. Ascending IDs additionally carry a leading
// "z" (the largest base62 char) so they string-sort after every legacy ID, keeping
// ID-ordered collections correct when old and new IDs share a store.
const timeBytes = 7
const timeHexChars = timeBytes * 2

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: timeBytes }, (_, index) =>
    Number((value >> BigInt((timeBytes - 1) * 8 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const randomLength = length - timeHexChars - (descending ? 0 : 1)
  const bytes = crypto.getRandomValues(new Uint8Array(randomLength))
  return (descending ? "" : "z") + time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}
