import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801103914_scheduler_reliable_delivery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`scheduled_event_delivery\` (
          \`id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`occurrence_at\` integer NOT NULL,
          \`delivery_key\` text NOT NULL,
          \`workspace_id\` text,
          \`directory\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`session_id\` text,
          \`event_type\` text NOT NULL,
          \`title\` text NOT NULL,
          \`body\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`available_at\` integer NOT NULL,
          \`attempt_count\` integer DEFAULT 0 NOT NULL,
          \`max_attempts\` integer NOT NULL,
          \`lease_owner\` text,
          \`lease_token\` integer DEFAULT 0 NOT NULL,
          \`lease_expires_at\` integer,
          \`last_error\` text,
          \`time_delivered\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_event_delivery_event_id_scheduled_event_id_fk\` FOREIGN KEY (\`event_id\`) REFERENCES \`scheduled_event\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`ALTER TABLE \`scheduled_event_audit\` ADD \`occurrence_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`scheduled_event_audit\` ADD \`delivery_key\` text;`)
      yield* tx.run(`ALTER TABLE \`scheduled_event\` ADD \`recurrence_rule\` text;`)
      yield* tx.run(`ALTER TABLE \`scheduled_event\` ADD \`recurrence_anchor_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`scheduled_event\` ADD \`misfire_policy\` text DEFAULT 'catch_up_once' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`scheduled_event\` ADD \`lease_token\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_event_delivery_occurrence_idx\` ON \`scheduled_event_delivery\` (\`event_id\`,\`occurrence_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_event_delivery_key_idx\` ON \`scheduled_event_delivery\` (\`delivery_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_event_delivery_available_idx\` ON \`scheduled_event_delivery\` (\`status\`,\`available_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_event_delivery_lease_idx\` ON \`scheduled_event_delivery\` (\`lease_expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
