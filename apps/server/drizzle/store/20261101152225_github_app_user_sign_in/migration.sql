CREATE TABLE `github_app_users` (
	`app_id` text PRIMARY KEY,
	`login` text NOT NULL,
	`user_id` integer NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`refresh_token` text NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	CONSTRAINT `fk_github_app_users_app_id_github_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `github_apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `github_apps` ADD `client_secret` text;--> statement-breakpoint
DROP TABLE `github_account_bots`;--> statement-breakpoint
DROP TABLE `github_accounts`;