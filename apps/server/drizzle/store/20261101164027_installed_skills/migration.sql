CREATE TABLE `skill_updates` (
	`skill_id` text PRIMARY KEY,
	`commit` text NOT NULL,
	`digest` text,
	`checked_at` text NOT NULL,
	CONSTRAINT `fk_skill_updates_skill_id_skills_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `skills` ADD `origin` text;