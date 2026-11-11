CREATE TABLE `deleted_library_files` (
	`id` text PRIMARY KEY,
	`agent_id` text,
	`group_id` text,
	`name` text NOT NULL,
	CONSTRAINT `fk_deleted_library_files_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_deleted_library_files_group_id_group_chats_id_fk` FOREIGN KEY (`group_id`) REFERENCES `group_chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT "deleted_library_files_one_owner" CHECK(("agent_id" IS NOT NULL) != ("group_id" IS NOT NULL))
);
