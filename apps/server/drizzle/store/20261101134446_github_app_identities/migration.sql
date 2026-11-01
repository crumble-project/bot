CREATE TABLE `github_app_bots` (
	`app_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`assigned_at` text NOT NULL,
	CONSTRAINT `github_app_bots_pk` PRIMARY KEY(`app_id`, `agent_id`),
	CONSTRAINT `fk_github_app_bots_app_id_github_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `github_apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_github_app_bots_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `github_apps` (
	`id` text PRIMARY KEY,
	`app_id` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`client_id` text NOT NULL,
	`private_key` text NOT NULL,
	`bot_user_id` integer NOT NULL,
	`html_url` text NOT NULL,
	`account` text,
	`installation_id` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
-- Each bot's App becomes an account App assigned to that bot; its ID reuses the bot's, which is unique per row.
INSERT INTO `github_apps`(`id`, `app_id`, `slug`, `name`, `client_id`, `private_key`, `bot_user_id`, `html_url`, `account`, `installation_id`, `created_at`) SELECT `agent_id`, `app_id`, `slug`, `name`, `client_id`, `private_key`, `bot_user_id`, `html_url`, `installed_on`, `installation_id`, `created_at` FROM `agent_github_apps`;--> statement-breakpoint
INSERT INTO `github_app_bots`(`app_id`, `agent_id`, `assigned_at`) SELECT `agent_id`, `agent_id`, `created_at` FROM `agent_github_apps`;--> statement-breakpoint
DROP TABLE `agent_github_apps`;