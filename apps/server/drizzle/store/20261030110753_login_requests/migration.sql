CREATE TABLE `login_requests` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`reason` text NOT NULL,
	`one_time_code` integer NOT NULL,
	`requested_at` text NOT NULL,
	CONSTRAINT `login_requests_pk` PRIMARY KEY(`agent_id`, `name`),
	CONSTRAINT `fk_login_requests_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
