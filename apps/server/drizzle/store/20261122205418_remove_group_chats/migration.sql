PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_deleted_library_files` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT `fk_deleted_library_files_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);

INSERT INTO `__new_deleted_library_files`(`id`, `agent_id`, `name`) SELECT `id`, `agent_id`, `name` FROM `deleted_library_files`;
DROP TABLE `deleted_library_files`;
ALTER TABLE `__new_deleted_library_files` RENAME TO `deleted_library_files`;
PRAGMA foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_library_files` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`text` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_library_files_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);

INSERT INTO `__new_library_files`(`id`, `agent_id`, `name`, `mime_type`, `size`, `hash`, `text`, `description`, `created_at`) SELECT `id`, `agent_id`, `name`, `mime_type`, `size`, `hash`, `text`, `description`, `created_at` FROM `library_files`;
DROP TABLE `library_files`;
ALTER TABLE `__new_library_files` RENAME TO `library_files`;
PRAGMA foreign_keys=ON;
DROP INDEX IF EXISTS `library_files_group_hash`;
CREATE UNIQUE INDEX `library_files_bot_hash` ON `library_files` (`agent_id`,`hash`);
DROP TABLE IF EXISTS `group_turns`;
DROP TABLE IF EXISTS `group_members`;
DROP TABLE IF EXISTS `group_chats`;