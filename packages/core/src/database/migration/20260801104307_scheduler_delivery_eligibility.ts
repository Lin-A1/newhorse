import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801104307_scheduler_delivery_eligibility",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_event\` ADD \`eligible_at\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
