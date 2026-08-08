import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808185428_daily_summary",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`daily_summary\` (
          \`date\` text PRIMARY KEY,
          \`content\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
