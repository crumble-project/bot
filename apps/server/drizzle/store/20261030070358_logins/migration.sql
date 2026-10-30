CREATE TABLE `login_fields` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`password_manager` text,
	`reference` text,
	CONSTRAINT `login_fields_pk` PRIMARY KEY(`agent_id`, `name`, `field`),
	CONSTRAINT `fk_login_fields_password_manager_password_managers_id_fk` FOREIGN KEY (`password_manager`) REFERENCES `password_managers`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_login_fields_agent_id_name_logins_agent_id_name_fk` FOREIGN KEY (`agent_id`,`name`) REFERENCES `logins`(`agent_id`,`name`) ON DELETE CASCADE,
	CONSTRAINT "login_fields_field" CHECK("field" IN ('username', 'password', 'one_time_code')),
	CONSTRAINT "login_fields_source" CHECK(("value" IS NOT NULL AND "password_manager" IS NULL AND "reference" IS NULL) OR ("value" IS NULL AND "password_manager" IS NOT NULL AND "reference" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `login_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`at` text NOT NULL,
	`host` text NOT NULL,
	`field` text NOT NULL,
	`error` text,
	CONSTRAINT `fk_login_uses_agent_id_name_logins_agent_id_name_fk` FOREIGN KEY (`agent_id`,`name`) REFERENCES `logins`(`agent_id`,`name`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `logins` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`hosts` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	CONSTRAINT `logins_pk` PRIMARY KEY(`agent_id`, `name`),
	CONSTRAINT `fk_logins_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `login_uses_by_login` ON `login_uses` (`agent_id`,`name`,`id`);--> statement-breakpoint
CREATE INDEX `login_uses_by_time` ON `login_uses` (`at`);