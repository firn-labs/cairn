CREATE TABLE `personality_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`sprint_id` text,
	`previous` text NOT NULL,
	`revised` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `personality_pinned` integer DEFAULT false NOT NULL;