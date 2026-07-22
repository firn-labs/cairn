ALTER TABLE `backlog_items` ADD `requested_by_team_id` text REFERENCES teams(id);--> statement-breakpoint
ALTER TABLE `backlog_items` ADD `collab_branch` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `interface` text DEFAULT '' NOT NULL;