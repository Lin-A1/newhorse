import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260817031215_goal_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`goal\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text DEFAULT 'open' NOT NULL,
          \`priority\` text DEFAULT 'medium' NOT NULL,
          \`deadline\` integer,
          \`done_reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`goal_session_status_idx\` ON \`goal\` (\`session_id\`,\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
