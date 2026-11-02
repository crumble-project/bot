-- Preserve definitions saved by the earlier, unmerged additive-avatar implementation.
UPDATE `agents` SET `avatar` = `avatar_definition` WHERE `avatar_definition` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `avatar_definition`;