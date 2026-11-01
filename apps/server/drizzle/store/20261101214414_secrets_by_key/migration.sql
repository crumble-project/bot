-- Every secret the owner enters becomes a row of `credentials` by key (see secretKey); the values keep their encryption.
-- Stored provider API keys sit inside encrypted JSON, so ProviderCredentials moves those on startup.
INSERT INTO `credentials` (`key`, `value`, `password_manager`, `reference`) SELECT 'bot:' || `agent_id` || ':credential:' || `name`, `value`, `password_manager`, `reference` FROM `agent_credentials` WHERE `github` = 0;--> statement-breakpoint
INSERT INTO `credentials` (`key`, `value`, `password_manager`, `reference`) SELECT 'bot:' || `agent_id` || ':login:' || `name` || ':' || `field`, `value`, `password_manager`, `reference` FROM `login_fields`;--> statement-breakpoint
INSERT INTO `credentials` (`key`, `password_manager`, `reference`) SELECT 'provider:' || `provider`, `password_manager`, `reference` FROM `provider_credentials` WHERE `reference` IS NOT NULL;--> statement-breakpoint
INSERT INTO `credentials` (`key`, `value`) SELECT 'github-account:' || `id`, `token` FROM `github_accounts`;--> statement-breakpoint
INSERT INTO `credentials` (`key`, `value`) SELECT 'github-app-client:' || `id`, `client_secret` FROM `github_apps` WHERE `client_secret` IS NOT NULL;--> statement-breakpoint
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
	`placeholder` text NOT NULL UNIQUE,
	`github` integer DEFAULT false NOT NULL,
	CONSTRAINT `agent_credentials_pk` PRIMARY KEY(`agent_id`, `name`),
	CONSTRAINT `fk_agent_credentials_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_agent_credentials`(`agent_id`, `name`, `hosts`, `created_at`, `updated_at`, `last_used_at`, `placeholder`, `github`) SELECT `agent_id`, `name`, `hosts`, `created_at`, `updated_at`, `last_used_at`, `placeholder`, `github` FROM `agent_credentials`;--> statement-breakpoint
DROP TABLE `agent_credentials`;--> statement-breakpoint
ALTER TABLE `__new_agent_credentials` RENAME TO `agent_credentials`;--> statement-breakpoint
INSERT INTO `credential_uses` SELECT * FROM `__credential_uses_backup`;--> statement-breakpoint
DROP TABLE `__credential_uses_backup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_credentials` (
	`provider` text PRIMARY KEY,
	`type` text NOT NULL,
	`value` text,
	CONSTRAINT "provider_credentials_type" CHECK("type" IN ('api_key', 'oauth'))
);
--> statement-breakpoint
INSERT INTO `__new_provider_credentials`(`provider`, `type`, `value`) SELECT `provider`, `type`, `value` FROM `provider_credentials`;--> statement-breakpoint
DROP TABLE `provider_credentials`;--> statement-breakpoint
ALTER TABLE `__new_provider_credentials` RENAME TO `provider_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP TABLE `login_fields`;--> statement-breakpoint
ALTER TABLE `github_accounts` DROP COLUMN `token`;--> statement-breakpoint
ALTER TABLE `github_apps` DROP COLUMN `client_secret`;