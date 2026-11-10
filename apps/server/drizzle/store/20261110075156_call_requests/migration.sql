CREATE TABLE `call_requests` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`number` text NOT NULL,
	`callee` text NOT NULL,
	`goal` text NOT NULL,
	`opening` text NOT NULL,
	`status` text NOT NULL,
	`call_id` text,
	`conversation_id` text,
	`outcome` text,
	`error` text,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`ended_at` text,
	CONSTRAINT `fk_call_requests_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `call_requests_by_agent` ON `call_requests` (`agent_id`);--> statement-breakpoint
CREATE INDEX `call_requests_by_call` ON `call_requests` (`call_id`);