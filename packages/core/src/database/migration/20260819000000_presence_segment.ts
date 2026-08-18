import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260819000000_presence_segment",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`presence_segment\` (
          \`day\` text NOT NULL,
          \`app\` text NOT NULL,
          \`start\` integer NOT NULL,
          \`end\` integer
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
