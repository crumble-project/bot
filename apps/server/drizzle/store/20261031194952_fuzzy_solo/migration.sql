CREATE TABLE `gateway_cooldowns` (
	`adapter_id` text NOT NULL,
	`scope` text NOT NULL,
	`channel_id` text NOT NULL,
	`until` integer NOT NULL,
	CONSTRAINT `gateway_cooldowns_pk` PRIMARY KEY(`adapter_id`, `scope`, `channel_id`)
);
--> statement-breakpoint
CREATE INDEX `gateway_cooldowns_expiry` ON `gateway_cooldowns` (`until`);