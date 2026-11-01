CREATE TABLE `agent_github_apps` (
	`agent_id` text PRIMARY KEY,
	`app_id` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`client_id` text NOT NULL,
	`private_key` text NOT NULL,
	`bot_user_id` integer NOT NULL,
	`html_url` text NOT NULL,
	`installation_id` integer,
	`installed_on` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_agent_github_apps_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Migrations run in a transaction, where foreign_keys=OFF has no effect: dropping agent_credentials would cascade into credential_uses.
CREATE TABLE `__credential_uses_backup` AS SELECT * FROM `credential_uses`;--> statement-breakpoint
CREATE TABLE `__new_agent_credentials` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	`value` text,
	`password_manager` text,
	`reference` text,
	`placeholder` text NOT NULL UNIQUE,
	`github_app` integer DEFAULT false NOT NULL,
	CONSTRAINT `agent_credentials_pk` PRIMARY KEY(`agent_id`, `name`),
	CONSTRAINT `fk_agent_credentials_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_agent_credentials_password_manager_password_managers_id_fk` FOREIGN KEY (`password_manager`) REFERENCES `password_managers`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "agent_credentials_source" CHECK(("github_app" = 0 AND (("value" IS NOT NULL AND "password_manager" IS NULL AND "reference" IS NULL) OR ("value" IS NULL AND "password_manager" IS NOT NULL AND "reference" IS NOT NULL))) OR ("github_app" = 1 AND "value" IS NULL AND "password_manager" IS NULL AND "reference" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_agent_credentials`(`agent_id`, `name`, `hosts`, `created_at`, `updated_at`, `last_used_at`, `value`, `password_manager`, `reference`, `placeholder`) SELECT `agent_id`, `name`, `hosts`, `created_at`, `updated_at`, `last_used_at`, `value`, `password_manager`, `reference`, `placeholder` FROM `agent_credentials`;--> statement-breakpoint
DROP TABLE `agent_credentials`;--> statement-breakpoint
ALTER TABLE `__new_agent_credentials` RENAME TO `agent_credentials`;--> statement-breakpoint
INSERT INTO `credential_uses` SELECT * FROM `__credential_uses_backup`;--> statement-breakpoint
DROP TABLE `__credential_uses_backup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;