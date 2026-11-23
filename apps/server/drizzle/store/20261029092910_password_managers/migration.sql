CREATE TABLE `password_managers` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL,
	`connected_at` text NOT NULL,
	CONSTRAINT "password_managers_id" CHECK("id" IN ('1password', 'bitwarden'))
);

PRAGMA foreign_keys=OFF;

CREATE TABLE `__credential_uses_backup` AS SELECT * FROM `credential_uses`;
CREATE TABLE `__new_agent_credentials` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`value` text,
	`password_manager` text,
	`reference` text,
	`placeholder` text NOT NULL UNIQUE,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	CONSTRAINT `agent_credentials_pk` PRIMARY KEY(`agent_id`, `name`),
	CONSTRAINT `fk_agent_credentials_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_agent_credentials_password_manager_password_managers_id_fk` FOREIGN KEY (`password_manager`) REFERENCES `password_managers`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "agent_credentials_source" CHECK(("value" IS NOT NULL AND "password_manager" IS NULL AND "reference" IS NULL) OR ("value" IS NULL AND "password_manager" IS NOT NULL AND "reference" IS NOT NULL))
);

INSERT INTO `__new_agent_credentials`(`agent_id`, `name`, `hosts`, `value`, `placeholder`, `created_at`, `updated_at`, `last_used_at`) SELECT `agent_id`, `name`, `hosts`, `value`, `placeholder`, `created_at`, `updated_at`, `last_used_at` FROM `agent_credentials`;
DROP TABLE `agent_credentials`;
ALTER TABLE `__new_agent_credentials` RENAME TO `agent_credentials`;
INSERT INTO `credential_uses` SELECT * FROM `__credential_uses_backup`;
DROP TABLE `__credential_uses_backup`;
PRAGMA foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_credentials` (
	`key` text PRIMARY KEY,
	`value` text,
	`password_manager` text,
	`reference` text,
	CONSTRAINT `fk_credentials_password_manager_password_managers_id_fk` FOREIGN KEY (`password_manager`) REFERENCES `password_managers`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "credentials_source" CHECK(("value" IS NOT NULL AND "password_manager" IS NULL AND "reference" IS NULL) OR ("value" IS NULL AND "password_manager" IS NOT NULL AND "reference" IS NOT NULL))
);

INSERT INTO `__new_credentials`(`key`, `value`) SELECT `key`, `value` FROM `credentials`;
DROP TABLE `credentials`;
ALTER TABLE `__new_credentials` RENAME TO `credentials`;
PRAGMA foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_provider_credentials` (
	`provider` text PRIMARY KEY,
	`type` text NOT NULL,
	`value` text,
	`password_manager` text,
	`reference` text,
	CONSTRAINT `fk_provider_credentials_password_manager_password_managers_id_fk` FOREIGN KEY (`password_manager`) REFERENCES `password_managers`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "provider_credentials_type" CHECK("type" IN ('api_key', 'oauth')),
	CONSTRAINT "provider_credentials_source" CHECK(("value" IS NOT NULL AND "password_manager" IS NULL AND "reference" IS NULL) OR ("value" IS NULL AND "password_manager" IS NOT NULL AND "reference" IS NOT NULL)),
	CONSTRAINT "provider_credentials_oauth_stored" CHECK("type" = 'api_key' OR "reference" IS NULL)
);

INSERT INTO `__new_provider_credentials`(`provider`, `type`, `value`) SELECT `provider`, `type`, `value` FROM `provider_credentials`;
DROP TABLE `provider_credentials`;
ALTER TABLE `__new_provider_credentials` RENAME TO `provider_credentials`;
PRAGMA foreign_keys=ON;