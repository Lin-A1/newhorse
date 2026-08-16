import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816111532_workbench_todo",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workbench_todo\` (
          \`id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`profile_id\` text,
          \`content\` text NOT NULL,
          \`status\` text DEFAULT 'open' NOT NULL,
          \`priority\` text DEFAULT 'medium' NOT NULL,
          \`deadline\` integer,
          \`source\` text DEFAULT 'user' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`workbench_todo_directory_status_idx\` ON \`workbench_todo\` (\`directory\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`workbench_todo_workspace_idx\` ON \`workbench_todo\` (\`workspace_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
