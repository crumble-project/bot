

INSERT INTO `credentials` (`key`, `value`, `password_manager`, `reference`) SELECT 'bot:' || `agent_id` || ':credential:' || `name`, `value`, `password_manager`, `reference` FROM `agent_credentials` WHERE `github` = 0;
INSERT INTO `credentials` (`key`, `value`, `password_manager`, `reference`) SELECT 'bot:' || `agent_id` || ':login:' || `name` || ':' || `field`, `value`, `password_manager`, `reference` FROM `login_fields`;
INSERT INTO `credentials` (`key`, `password_manager`, `reference`) SELECT 'provider:' || `provider`, `password_manager`, `reference` FROM `provider_credentials` WHERE `reference` IS NOT NULL;
INSERT INTO `credentials` (`key`, `value`) SELECT 'github-account:' || `id`, `token` FROM `github_accounts`;
INSERT INTO `credentials` (`key`, `value`) SELECT 'github-app-client:' || `id`, `client_secret` FROM `github_apps` WHERE `client_secret` IS NOT NULL;
PRAGMA foreign_keys=OFF;

CREATE TABLE `__credential_uses_backup` AS SELECT * FROM `credential_uses`;
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

INSERT INTO `__new_agent_credentials`(`agent_id`, `name`, `hosts`, `created_at`, `updated_at`, `last_used_at`, `placeholder`, `github`) SELECT `agent_id`, `name`, `hosts`, `created_at`, `updated_at`, `last_used_at`, `placeholder`, `github` FROM `agent_credentials`;
DROP TABLE `agent_credentials`;
ALTER TABLE `__new_agent_credentials` RENAME TO `agent_credentials`;
INSERT INTO `credential_uses` SELECT * FROM `__credential_uses_backup`;
DROP TABLE `__credential_uses_backup`;
PRAGMA foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_provider_credentials` (
	`provider` text PRIMARY KEY,
	`type` text NOT NULL,
	`value` text,
	CONSTRAINT "provider_credentials_type" CHECK("type" IN ('api_key', 'oauth'))
);

INSERT INTO `__new_provider_credentials`(`provider`, `type`, `value`) SELECT `provider`, `type`, `value` FROM `provider_credentials`;
DROP TABLE `provider_credentials`;
ALTER TABLE `__new_provider_credentials` RENAME TO `provider_credentials`;
PRAGMA foreign_keys=ON;
DROP TABLE `login_fields`;
ALTER TABLE `github_accounts` DROP COLUMN `token`;
ALTER TABLE `github_apps` DROP COLUMN `client_secret`;