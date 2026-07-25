import { run as runTui, type TuiInput } from "@newhorse/tui"
import { Global } from "@newhorse/core/global"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
