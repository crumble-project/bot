CREATE TABLE `script_runs` (
	`id` text PRIMARY KEY,
	`schedule_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`output` text DEFAULT '' NOT NULL,
	`dropped_bytes` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT `fk_script_runs_schedule_id_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `schedules` ADD `kind` text DEFAULT 'prompt' NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `command` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `timeout_seconds` integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `notify` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `script_runs_by_schedule` ON `script_runs` (`schedule_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `script_runs_by_time` ON `script_runs` (`started_at`);