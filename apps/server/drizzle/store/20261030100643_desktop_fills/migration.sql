CREATE TABLE `desktop_fills` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`agent_id` text NOT NULL,
	`value` text NOT NULL,
	`label` text NOT NULL,
	`browser` text NOT NULL,
	`filled_at` text NOT NULL,
	CONSTRAINT `fk_desktop_fills_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `desktop_fills_agent` ON `desktop_fills` (`agent_id`);