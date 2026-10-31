CREATE TABLE `gateway_receipts` (
	`adapter_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`is_direct_message` integer NOT NULL,
	`bot_id` text,
	`request_id` text NOT NULL,
	`text` text NOT NULL,
	`execution_id` text,
	`chunks` text,
	`sent` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `gateway_receipts_pk` PRIMARY KEY(`adapter_id`, `message_id`)
);
