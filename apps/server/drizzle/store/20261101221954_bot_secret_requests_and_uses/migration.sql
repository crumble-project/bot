CREATE TABLE `bot_secret_requests` (
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`reason` text NOT NULL,
	`one_time_code` integer DEFAULT false NOT NULL,
	`requested_at` text NOT NULL,
	CONSTRAINT `bot_secret_requests_pk` PRIMARY KEY(`agent_id`, `kind`, `name`),
	CONSTRAINT `fk_bot_secret_requests_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT "bot_secret_requests_kind" CHECK("kind" IN ('credential', 'login'))
);
--> statement-breakpoint
CREATE TABLE `bot_secret_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`at` text NOT NULL,
	`host` text NOT NULL,
	`error` text,
	`detail` text NOT NULL,
	CONSTRAINT `fk_bot_secret_uses_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT "bot_secret_uses_kind" CHECK("kind" IN ('credential', 'login'))
);
--> statement-breakpoint
DROP INDEX IF EXISTS `credential_uses_by_credential`;--> statement-breakpoint
DROP INDEX IF EXISTS `credential_uses_by_time`;--> statement-breakpoint
DROP INDEX IF EXISTS `login_uses_by_login`;--> statement-breakpoint
DROP INDEX IF EXISTS `login_uses_by_time`;--> statement-breakpoint
CREATE INDEX `bot_secret_uses_by_secret` ON `bot_secret_uses` (`agent_id`,`kind`,`name`,`id`);--> statement-breakpoint
CREATE INDEX `bot_secret_uses_by_time` ON `bot_secret_uses` (`at`);--> statement-breakpoint
-- Credentials and logins share one table of requests and one of uses; a use's kind-specific fields move into `detail`.
INSERT INTO `bot_secret_requests` (`agent_id`, `kind`, `name`, `hosts`, `reason`, `requested_at`) SELECT `agent_id`, 'credential', `name`, `hosts`, `reason`, `requested_at` FROM `credential_requests`;--> statement-breakpoint
INSERT INTO `bot_secret_requests` (`agent_id`, `kind`, `name`, `hosts`, `reason`, `one_time_code`, `requested_at`) SELECT `agent_id`, 'login', `name`, `hosts`, `reason`, `one_time_code`, `requested_at` FROM `login_requests`;--> statement-breakpoint
INSERT INTO `bot_secret_uses` (`agent_id`, `kind`, `name`, `at`, `host`, `error`, `detail`) SELECT `agent_id`, 'credential', `name`, `at`, `host`, `error`, json_object('method', `method`, 'path', `path`, 'status', `status`) FROM `credential_uses` ORDER BY `id`;--> statement-breakpoint
INSERT INTO `bot_secret_uses` (`agent_id`, `kind`, `name`, `at`, `host`, `error`, `detail`) SELECT `agent_id`, 'login', `name`, `at`, `host`, `error`, json_object('field', `field`) FROM `login_uses` ORDER BY `id`;--> statement-breakpoint
DROP TABLE `credential_requests`;--> statement-breakpoint
DROP TABLE `credential_uses`;--> statement-breakpoint
DROP TABLE `login_requests`;--> statement-breakpoint
DROP TABLE `login_uses`;