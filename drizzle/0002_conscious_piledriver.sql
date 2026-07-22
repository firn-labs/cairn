CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`repo_url` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`token_ciphertext` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sprints` ADD `pr_url` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `project_id` text REFERENCES projects(id);