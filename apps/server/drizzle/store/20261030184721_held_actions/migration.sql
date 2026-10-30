CREATE TABLE `held_actions` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`job` text NOT NULL,
	`action` text NOT NULL,
	`page` text,
	`owner_messages` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`decline_reason` text,
	`held_at` text NOT NULL,
	`decided_at` text,
	CONSTRAINT `fk_held_actions_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `held_actions_agent` ON `held_actions` (`agent_id`);