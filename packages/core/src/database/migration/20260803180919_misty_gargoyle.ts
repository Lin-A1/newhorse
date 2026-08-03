import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803180919_misty_gargoyle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`policy_audit\` (
          \`id\` text PRIMARY KEY,
          \`time\` integer NOT NULL,
          \`action\` text NOT NULL,
          \`source\` text NOT NULL,
          \`destination\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`actor\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`policy_audit_time_idx\` ON \`policy_audit\` (\`time\`);`)
      yield* tx.run(`CREATE INDEX \`policy_audit_action_idx\` ON \`policy_audit\` (\`action\`,\`time\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
