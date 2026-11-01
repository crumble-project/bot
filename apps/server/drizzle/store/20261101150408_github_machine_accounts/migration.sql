CREATE TABLE `github_account_bots` (
	`agent_id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`assigned_at` text NOT NULL,
	CONSTRAINT `fk_github_account_bots_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_github_account_bots_account_id_github_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `github_accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `github_accounts` (
	`id` text PRIMARY KEY,
	`login` text NOT NULL,
	`user_id` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
-- SQLite rewrites the source CHECK with the column, so the table isn't rebuilt and its use log survives.
ALTER TABLE `agent_credentials` RENAME COLUMN `github_app` TO `github`;