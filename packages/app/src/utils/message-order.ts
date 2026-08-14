import type { Message } from "@newhorse/sdk/v2/client"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Message arrays in the app are ordered by (time_created, id) so ordering survives
// the 48-bit ID timestamp rollover (2026-08-14T11:19:55Z): time_created is a plain
// number that never wraps, while the ID string can. The server orders messages by
// (time_created, id) too, so this aligns the app with the server.
export const cmpMessage = (a: Message, b: Message): number => a.time.created - b.time.created || cmp(a.id, b.id)

export function sortMessages<T extends Message>(items: T[]): T[] {
  return items.sort(cmpMessage)
}

export function mergeMessages<T extends Message>(a: readonly T[], b: readonly T[]): T[] {
  const items = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) items.set(item.id, item)
  return [...items.values()].sort(cmpMessage)
}
