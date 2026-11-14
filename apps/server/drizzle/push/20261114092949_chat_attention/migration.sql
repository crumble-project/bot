CREATE TABLE `chat_views` (
	`view_id` text PRIMARY KEY,
	`chat_kind` text NOT NULL,
	`chat_id` text NOT NULL,
	`refreshed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reply_associations` (
	`event_id` text PRIMARY KEY,
	`chat_kind` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`surface_json` text NOT NULL,
	`seen` integer DEFAULT false NOT NULL
);
