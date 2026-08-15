import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// The four-level scope split (20260814120000_memory_scope_four_level) ran
// without a WorkspacePolicy and mapped EVERY legacy scope='workspace' row to
// 'project'. Rows owned by a PERSONAL workspace were really personal-scoped, so
// they became invisible in the personal Memory Center (whose visible filter only
// shows personal + relationship + user_global).
//
// Personal workspaces can never create project-scoped rows: the trust policy
// rejects a project destination from a personal source (memory.save), and
// mutation filters scope updates by the workspace's own scope. So any
// scope='project' row owned by a personal workspace is unambiguously a legacy
// workspace row that the original split mislabeled — reclassify it back.
export default {
  id: "20260815000000_memory_personal_scope_fix",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        UPDATE memory SET scope='personal'
        WHERE scope='project'
          AND workspace_id IS NOT NULL
          AND workspace_id IN (SELECT id FROM workspace WHERE type='personal');
      `)
    })
  },
} satisfies DatabaseMigration.Migration
