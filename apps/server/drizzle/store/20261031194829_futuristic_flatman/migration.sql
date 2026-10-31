CREATE TABLE `gateway_sent_messages` (
	`adapter_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`external_message_id` text NOT NULL,
	`receipt_message_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`expires_at` integer,
	CONSTRAINT `gateway_sent_messages_pk` PRIMARY KEY(`adapter_id`, `channel_id`, `external_message_id`),
	CONSTRAINT `fk_gateway_sent_messages_adapter_id_receipt_message_id_gateway_receipts_adapter_id_message_id_fk` FOREIGN KEY (`adapter_id`,`receipt_message_id`) REFERENCES `gateway_receipts`(`adapter_id`,`message_id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `gateway_receipts` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_receipts` ADD `expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_receipts` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_receipts` ADD `next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `gateway_receipts` ADD `failed_at` integer;--> statement-breakpoint
ALTER TABLE `gateway_receipts` ADD `finished_at` integer;--> statement-breakpoint
CREATE INDEX `gateway_receipts_pending` ON `gateway_receipts` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `gateway_receipts_retention` ON `gateway_receipts` (`finished_at`);--> statement-breakpoint
CREATE INDEX `gateway_sent_messages_receipt` ON `gateway_sent_messages` (`adapter_id`,`receipt_message_id`);--> statement-breakpoint
UPDATE `gateway_receipts`
SET `created_at` = CAST(unixepoch('subsec') * 1000 AS integer),
    `expires_at` = CAST(unixepoch('subsec') * 1000 AS integer) + 86400000,
    `finished_at` = CASE WHEN `state` = 'pending' THEN NULL ELSE CAST(unixepoch('subsec') * 1000 AS integer) END;
--> statement-breakpoint
INSERT OR IGNORE INTO `gateway_sent_messages` (`adapter_id`, `channel_id`, `external_message_id`, `receipt_message_id`, `bot_id`, `expires_at`)
SELECT r.`adapter_id`, r.`channel_id`, j.value, r.`message_id`, r.`bot_id`,
       CASE WHEN r.`finished_at` IS NULL THEN NULL ELSE r.`finished_at` + 2592000000 END
FROM `gateway_receipts` r, json_each(CASE WHEN json_valid(r.`sent`) THEN r.`sent` ELSE '[]' END) j
WHERE r.`bot_id` IS NOT NULL AND j.type = 'text';
--> statement-breakpoint
UPDATE `gateway_receipts` SET `text` = '', `chunks` = NULL, `sent` = '[]', `next_attempt_at` = NULL WHERE `state` <> 'pending';
