-- Baseline: the schema servers created before Drizzle. IF NOT EXISTS lets databases that already have it record it as applied.
CREATE TABLE IF NOT EXISTS `agents` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`avatar` text NOT NULL,
	`description` text NOT NULL,
	`instructions` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`enabled` integer NOT NULL,
	`tools` text NOT NULL,
	`skills` text NOT NULL,
	`mcp_servers` text NOT NULL,
	`delegates` text DEFAULT '[]' NOT NULL,
	`inference` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`shared_skills` text DEFAULT '[]' NOT NULL,
	`desktop_model` text,
	`review_model` text,
	`review` text,
	`shared_memory` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`title` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_conversations_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `executions` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`schedule_id` text,
	`submission_id` text,
	`request_id` text NOT NULL,
	`prompt` text,
	`reply_to` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`attachments` text,
	`attachments_digest` text,
	CONSTRAINT `fk_executions_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_executions_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_executions_schedule_id_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `desktop_control` (
	`agent_id` text PRIMARY KEY,
	`holder` text NOT NULL,
	`changes` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_desktop_control_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_credentials` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`value` text NOT NULL,
	`placeholder` text NOT NULL UNIQUE,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	CONSTRAINT `agent_credentials_pk` PRIMARY KEY(`agent_id`, `name`),
	CONSTRAINT `fk_agent_credentials_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credential_authorities` (
	`agent_id` text PRIMARY KEY,
	`certificate` text NOT NULL,
	`key` text NOT NULL,
	CONSTRAINT `fk_credential_authorities_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credential_requests` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`reason` text NOT NULL,
	`requested_at` text NOT NULL,
	CONSTRAINT `credential_requests_pk` PRIMARY KEY(`agent_id`, `name`),
	CONSTRAINT `fk_credential_requests_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credential_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`at` text NOT NULL,
	`method` text NOT NULL,
	`host` text NOT NULL,
	`path` text NOT NULL,
	`status` integer,
	CONSTRAINT `fk_credential_uses_agent_id_name_agent_credentials_agent_id_name_fk` FOREIGN KEY (`agent_id`,`name`) REFERENCES `agent_credentials`(`agent_id`,`name`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credentials` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `group_chats` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`bot_turns` integer DEFAULT 0 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`awaiting_answers` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `group_members` (
	`group_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`joined_at` text NOT NULL,
	`conversation_id` text,
	`cursor` integer DEFAULT 0 NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`pending_bot_started` integer DEFAULT false NOT NULL,
	`summary` text,
	CONSTRAINT `group_members_pk` PRIMARY KEY(`group_id`, `agent_id`),
	CONSTRAINT `fk_group_members_group_id_group_chats_id_fk` FOREIGN KEY (`group_id`) REFERENCES `group_chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_group_members_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `group_turns` (
	`execution_id` text PRIMARY KEY,
	`group_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`through` integer NOT NULL,
	`bot_started` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_group_turns_execution_id_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_group_turns_group_id_group_chats_id_fk` FOREIGN KEY (`group_id`) REFERENCES `group_chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_group_turns_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_servers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`enabled` integer NOT NULL,
	`agent_id` text,
	`oauth_client_id` text,
	CONSTRAINT `fk_mcp_servers_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `memories` (
	`id` text PRIMARY KEY,
	`agent_id` text,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`source` text,
	CONSTRAINT `fk_memories_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `provider_credentials` (
	`provider` text PRIMARY KEY,
	`type` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "provider_credentials_type" CHECK("type" IN ('api_key', 'oauth'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `schedules` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`cron` text,
	`timezone` text NOT NULL,
	`run_at` text,
	`enabled` integer NOT NULL,
	`next_run_at` text,
	`created_at` text NOT NULL,
	`created_by_agent_id` text,
	CONSTRAINT `fk_schedules_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `learned_changes` (
	`id` text PRIMARY KEY,
	`agent_id` text,
	`actor` text NOT NULL,
	`target` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`before_state` text,
	`after_state` text,
	`source` text,
	`reverts_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pending_reviews` (
	`execution_id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_pending_reviews_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_counters` (
	`agent_id` text PRIMARY KEY,
	`skill_rounds` integer DEFAULT 0 NOT NULL,
	`memory_rounds` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_review_counters_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_results` (
	`execution_id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`change_ids` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_review_results_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skill_documents` (
	`skill_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `skill_documents_pk` PRIMARY KEY(`skill_id`, `path`),
	CONSTRAINT `fk_skill_documents_skill_id_skills_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skills` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`agent_id` text,
	`description` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT 'owner' NOT NULL,
	`source_execution_id` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`state` text DEFAULT 'active' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_skills_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `executions_conversation_request` ON `executions` (`conversation_id`,`request_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `credential_uses_by_credential` ON `credential_uses` (`agent_id`,`name`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `credential_uses_by_time` ON `credential_uses` (`at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `learned_changes_agent` ON `learned_changes` (`agent_id`,`created_at`);