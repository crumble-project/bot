CREATE TABLE `library_files` (
	`id` text PRIMARY KEY,
	`agent_id` text,
	`group_id` text,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_library_files_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_library_files_group_id_group_chats_id_fk` FOREIGN KEY (`group_id`) REFERENCES `group_chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT "library_files_one_owner" CHECK(("agent_id" IS NOT NULL) != ("group_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_files_bot_hash` ON `library_files` (`agent_id`,`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_files_group_hash` ON `library_files` (`group_id`,`hash`);