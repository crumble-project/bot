CREATE TABLE `event_runs` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_event_runs_event_id_relay_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `relay_events`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_event_runs_schedule_id_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_runs_once` ON `event_runs` (`event_id`,`schedule_id`);--> statement-breakpoint
CREATE INDEX `event_runs_by_schedule` ON `event_runs` (`schedule_id`,`status`,`event_id`);