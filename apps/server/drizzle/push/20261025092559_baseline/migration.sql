-- Baseline: the schema servers created before Drizzle. IF NOT EXISTS lets databases that already have it record it as applied.
CREATE TABLE IF NOT EXISTS `push_delivery` (
	`outbox_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`delivered` integer DEFAULT false NOT NULL,
	CONSTRAINT `push_delivery_pk` PRIMARY KEY(`outbox_id`, `installation_id`),
	CONSTRAINT `fk_push_delivery_outbox_id_push_outbox_id_fk` FOREIGN KEY (`outbox_id`) REFERENCES `push_outbox`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_push_delivery_installation_id_push_devices_installation_id_fk` FOREIGN KEY (`installation_id`) REFERENCES `push_devices`(`installation_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_devices` (
	`installation_id` text PRIMARY KEY,
	`platform` text NOT NULL,
	`transport` text NOT NULL,
	`token` text NOT NULL,
	`environment` text NOT NULL,
	`bundle_id` text,
	`enabled` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_outbox` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`event_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_presence` (
	`installation_id` text PRIMARY KEY,
	`active` integer NOT NULL,
	`agent_id` text,
	`refreshed_at` integer NOT NULL,
	CONSTRAINT `fk_push_presence_installation_id_push_devices_installation_id_fk` FOREIGN KEY (`installation_id`) REFERENCES `push_devices`(`installation_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
