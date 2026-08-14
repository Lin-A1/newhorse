import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Expand memory scope from 2 levels (workspace/user_global) to 4 levels
// (project/personal/relationship/user_global), aligning the memory data model
// with the trust policy's ContentScope. Relationship memories — previously
// scope="workspace" + kind="relationship" + profile_id — become first-class
// scope="relationship". Migrations run without a runtime WorkspacePolicy, so
// remaining workspace rows uniformly default to "project"; personal workspaces
// naturally land "personal" on subsequent writes.
export default {
  id: "20260814120000_memory_scope_four_level",
  up(tx) {
    return Effect.gen(function* () {
      // Relationship rows move to their own scope first.
      yield* tx.run(
        `UPDATE memory SET scope='relationship' WHERE scope='workspace' AND kind='relationship';`,
      )
      // Everything else that was workspace-scoped defaults to project.
      yield* tx.run(`UPDATE memory SET scope='project' WHERE scope='workspace';`)
    })
  },
} satisfies DatabaseMigration.Migration
