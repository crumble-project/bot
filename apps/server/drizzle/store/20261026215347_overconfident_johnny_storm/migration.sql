CREATE TABLE `bot_requests` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`proposal` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`created_agent_id` text,
	`requested_at` text NOT NULL,
	`decided_at` text,
	CONSTRAINT `fk_bot_requests_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `bot_requests_by_agent` ON `bot_requests` (`agent_id`);
