import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806042148_simple_nova",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`follow\` (
          \`id\` text PRIMARY KEY,
          \`workspace_id\` text,
          \`directory\` text,
          \`scope\` text DEFAULT 'personal' NOT NULL,
          \`profile_id\` text,
          \`kind\` text NOT NULL,
          \`topic\` text NOT NULL,
          \`check_interval_minutes\` integer DEFAULT 60 NOT NULL,
          \`last_value\` text,
          \`last_checked_at\` integer,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`follow_profile_idx\` ON \`follow\` (\`profile_id\`);`)
      yield* tx.run(`CREATE INDEX \`follow_scope_status_idx\` ON \`follow\` (\`scope\`,\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
