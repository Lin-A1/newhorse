import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725172900_add_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`workspace_id\` text,
          \`scope\` text NOT NULL,
          \`profile_id\` text,
          \`kind\` text NOT NULL,
          \`content\` text NOT NULL,
          \`source_session_id\` text,
          \`source_message_id\` text,
          \`provenance\` text NOT NULL,
          \`confidence\` real,
          \`sensitivity\` text DEFAULT 'normal' NOT NULL,
          \`status\` text DEFAULT 'proposed' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_expires\` integer
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_workspace_idx\` ON \`memory\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_scope_idx\` ON \`memory\` (\`scope\`);`)
      yield* tx.run(`CREATE INDEX \`memory_status_idx\` ON \`memory\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
