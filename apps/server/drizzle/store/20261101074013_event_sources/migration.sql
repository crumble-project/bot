CREATE TABLE `event_sources` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_events` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`received_at` text NOT NULL,
	`method` text NOT NULL,
	`query` text NOT NULL,
	`headers` text NOT NULL,
	`body` text NOT NULL,
	`stored_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `schedules` ADD `event_source_id` text;--> statement-breakpoint
CREATE INDEX `relay_events_by_stored_at` ON `relay_events` (`stored_at`);