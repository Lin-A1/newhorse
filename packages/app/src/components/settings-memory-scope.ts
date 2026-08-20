import type { MemoryAggregateGroup, MemoryInfo } from "@newhorse/sdk/v2"

// The Memory Center splits records by scope type into two tabs: "workspace"
// carries every workspace-scoped record (project/personal/relationship) and
// "global" carries only user_global records. Keep the split pure so the tab
// filtering can be unit-tested without loading the solid-js component tree.
export function splitByScope(items: MemoryInfo[]): { workspace: MemoryInfo[]; global: MemoryInfo[] } {
  return {
    workspace: items.filter((item) => item.scope !== "user_global"),
    global: items.filter((item) => item.scope === "user_global"),
  }
}

export function splitAggregateByScope(groups: MemoryAggregateGroup[]): {
  workspace: MemoryAggregateGroup[]
  global: MemoryAggregateGroup[]
} {
  return {
    workspace: groups.filter((group) => group.scope === "workspace"),
    global: groups.filter((group) => group.scope === "user_global"),
  }
}
