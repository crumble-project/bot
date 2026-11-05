CREATE TABLE `bot_message_requests` (
	`request_id` text PRIMARY KEY,
	`source_agent_id` text NOT NULL,
	`target_agent_id` text NOT NULL,
	`recipient` text NOT NULL,
	`message` text NOT NULL,
	CONSTRAINT `fk_bot_message_requests_source_agent_id_agents_id_fk` FOREIGN KEY (`source_agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_bot_message_requests_target_agent_id_agents_id_fk` FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `delegation_receipts` (
	`execution_id` text PRIMARY KEY,
	`source_agent_id` text NOT NULL,
	`target_agent_id` text NOT NULL,
	CONSTRAINT `fk_delegation_receipts_execution_id_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_delegation_receipts_source_agent_id_agents_id_fk` FOREIGN KEY (`source_agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_delegation_receipts_target_agent_id_agents_id_fk` FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `relayed_job_questions` (
	`question_id` text PRIMARY KEY,
	`reporter_agent_id` text NOT NULL,
	`assignee_agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`job` text NOT NULL,
	CONSTRAINT `fk_relayed_job_questions_reporter_agent_id_agents_id_fk` FOREIGN KEY (`reporter_agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_relayed_job_questions_assignee_agent_id_agents_id_fk` FOREIGN KEY (`assignee_agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `chat` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `conversations` SET `chat` = 1 WHERE `id` IN (SELECT json_extract(`value`, '$') FROM `settings` WHERE `key` LIKE 'chat:%');--> statement-breakpoint
DELETE FROM `settings` WHERE `key` LIKE 'chat:%' OR `key` LIKE 'delegation-receipt:%' OR `key` LIKE 'bot-message-request:%' OR `key` LIKE 'job-question:%';--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `skills`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `delegates`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `shared_memory`;