import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`continuity_grant_audit\` (
          \`id\` text PRIMARY KEY,
          \`grant_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`reason\` text,
          \`destination_session_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_continuity_grant_audit_grant_id_continuity_grant_id_fk\` FOREIGN KEY (\`grant_id\`) REFERENCES \`continuity_grant\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`continuity_grant\` (
          \`id\` text PRIMARY KEY,
          \`source_workspace_id\` text,
          \`source_directory\` text NOT NULL,
          \`source_profile_id\` text NOT NULL,
          \`source_session_id\` text NOT NULL,
          \`destination_workspace_id\` text NOT NULL,
          \`destination_directory\` text NOT NULL,
          \`destination_profile_id\` text NOT NULL,
          \`destination_session_id\` text NOT NULL,
          \`purpose\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`relationship_persistence\` integer DEFAULT false NOT NULL,
          \`time_expires\` integer NOT NULL,
          \`status\` text DEFAULT 'proposed' NOT NULL,
          \`time_approved\` integer,
          \`time_revoked\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`daily_summary\` (
          \`date\` text PRIMARY KEY,
          \`content\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`memory_entity\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`entity_text\` text NOT NULL,
          \`entity_type\` text NOT NULL,
          \`normalized_text\` text NOT NULL,
          CONSTRAINT \`fk_memory_entity_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_history\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text,
          \`old_content\` text,
          \`new_content\` text,
          \`event\` text NOT NULL,
          \`actor_id\` text,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`workspace_id\` text,
          \`directory\` text,
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
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_event_audit\` (
          \`id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`reason\` text,
          \`occurrence_at\` integer,
          \`delivery_key\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_event_audit_event_id_scheduled_event_id_fk\` FOREIGN KEY (\`event_id\`) REFERENCES \`scheduled_event\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`scheduled_event\` (
          \`id\` text PRIMARY KEY,
          \`idempotency_key\` text NOT NULL,
          \`workspace_id\` text,
          \`directory\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`session_id\` text,
          \`type\` text NOT NULL,
          \`title\` text NOT NULL,
          \`body\` text NOT NULL,
          \`schedule_at\` integer NOT NULL,
          \`eligible_at\` integer DEFAULT 0 NOT NULL,
          \`timezone\` text NOT NULL,
          \`recurrence_rule\` text,
          \`recurrence_anchor_at\` integer,
          \`misfire_policy\` text DEFAULT 'catch_up_once' NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`lease_owner\` text,
          \`lease_token\` integer DEFAULT 0 NOT NULL,
          \`lease_expires_at\` integer,
          \`attempt_count\` integer DEFAULT 0 NOT NULL,
          \`last_error\` text,
          \`last_fired_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`profile_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
        `CREATE INDEX \`continuity_grant_audit_idx\` ON \`continuity_grant_audit\` (\`grant_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`continuity_grant_source_idx\` ON \`continuity_grant\` (\`source_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`continuity_grant_destination_idx\` ON \`continuity_grant\` (\`destination_session_id\`,\`destination_workspace_id\`,\`destination_profile_id\`,\`status\`,\`time_expires\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`follow_profile_idx\` ON \`follow\` (\`profile_id\`);`)
      yield* tx.run(`CREATE INDEX \`follow_scope_status_idx\` ON \`follow\` (\`scope\`,\`status\`);`)
      yield* tx.run(`CREATE INDEX \`memory_entity_memory_idx\` ON \`memory_entity\` (\`memory_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_entity_normalized_idx\` ON \`memory_entity\` (\`normalized_text\`,\`memory_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_history_memory_idx\` ON \`memory_history\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_history_created_at_idx\` ON \`memory_history\` (\`created_at\`);`)
      yield* tx.run(`CREATE INDEX \`memory_workspace_idx\` ON \`memory\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_directory_idx\` ON \`memory\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`memory_scope_idx\` ON \`memory\` (\`scope\`);`)
      yield* tx.run(`CREATE INDEX \`memory_status_idx\` ON \`memory\` (\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_scope_owner_profile_status_time_idx\` ON \`memory\` (\`scope\`,\`workspace_id\`,\`directory\`,\`profile_id\`,\`status\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_relationship_profile_status_idx\` ON \`memory\` (\`kind\`,\`profile_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_event_audit_event_idx\` ON \`scheduled_event_audit\` (\`event_id\`,\`time_created\`);`,
      )
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
      yield* tx.run(`CREATE INDEX \`scheduled_event_due_idx\` ON \`scheduled_event\` (\`status\`,\`eligible_at\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_event_lease_idx\` ON \`scheduled_event\` (\`lease_expires_at\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_event_workspace_idx\` ON \`scheduled_event\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_event_profile_idx\` ON \`scheduled_event\` (\`profile_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_event_idempotency_idx\` ON \`scheduled_event\` (\`idempotency_key\`,\`profile_id\`,coalesce("workspace_id", "directory"));`,
      )
      yield* tx.run(`CREATE INDEX \`goal_session_status_idx\` ON \`goal\` (\`session_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_profile_idx\` ON \`session\` (\`profile_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_usage_directory_idx\` ON \`session_usage\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`policy_audit_time_idx\` ON \`policy_audit\` (\`time\`);`)
      yield* tx.run(`CREATE INDEX \`policy_audit_action_idx\` ON \`policy_audit\` (\`action\`,\`time\`);`)
      yield* tx.run(
        `CREATE INDEX \`workbench_todo_directory_status_idx\` ON \`workbench_todo\` (\`directory\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`workbench_todo_workspace_idx\` ON \`workbench_todo\` (\`workspace_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
