import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813155258_fluffy_bruce_banner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_usage\` (
          \`session_id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`model_id\` text,
          \`provider_id\` text,
          \`time_created\` integer
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_usage_directory_idx\` ON \`session_usage\` (\`directory\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
