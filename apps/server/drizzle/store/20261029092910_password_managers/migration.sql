CREATE TABLE `password_managers` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL,
	`connected_at` text NOT NULL,
	CONSTRAINT "password_managers_id" CHECK("id" IN ('1password', 'bitwarden'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Migrations run in a transaction, where foreign_keys=OFF has no effect: dropping agent_credentials would cascade into credential_uses.
CREATE TABLE `__credential_uses_backup` AS SELECT * FROM `credential_uses`;--> statement-breakpoint
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
--> statement-breakpoint
INSERT INTO `__new_agent_credentials`(`agent_id`, `name`, `hosts`, `value`, `placeholder`, `created_at`, `updated_at`, `last_used_at`) SELECT `agent_id`, `name`, `hosts`, `value`, `placeholder`, `created_at`, `updated_at`, `last_used_at` FROM `agent_credentials`;--> statement-breakpoint
DROP TABLE `agent_credentials`;--> statement-breakpoint
ALTER TABLE `__new_agent_credentials` RENAME TO `agent_credentials`;--> statement-breakpoint
INSERT INTO `credential_uses` SELECT * FROM `__credential_uses_backup`;--> statement-breakpoint
DROP TABLE `__credential_uses_backup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credentials` (
	`key` text PRIMARY KEY,
	`value` text,
	`password_manager` text,
	`reference` text,
	CONSTRAINT `fk_credentials_password_manager_password_managers_id_fk` FOREIGN KEY (`password_manager`) REFERENCES `password_managers`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "credentials_source" CHECK(("value" IS NOT NULL AND "password_manager" IS NULL AND "reference" IS NULL) OR ("value" IS NULL AND "password_manager" IS NOT NULL AND "reference" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_credentials`(`key`, `value`) SELECT `key`, `value` FROM `credentials`;--> statement-breakpoint
DROP TABLE `credentials`;--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
--> statement-breakpoint
INSERT INTO `__new_provider_credentials`(`provider`, `type`, `value`) SELECT `provider`, `type`, `value` FROM `provider_credentials`;--> statement-breakpoint
DROP TABLE `provider_credentials`;--> statement-breakpoint
ALTER TABLE `__new_provider_credentials` RENAME TO `provider_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;