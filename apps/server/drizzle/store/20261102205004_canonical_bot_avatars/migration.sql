
UPDATE `agents` SET `avatar` = `avatar_definition` WHERE `avatar_definition` IS NOT NULL;

ALTER TABLE `agents` DROP COLUMN `avatar_definition`;