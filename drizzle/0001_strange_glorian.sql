CREATE TABLE `work_item_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`work_run_id` text NOT NULL,
	`backlog_item_id` text NOT NULL,
	`agent_id` text,
	`executor` text DEFAULT 'tool-loop' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`branch` text NOT NULL,
	`result_note` text DEFAULT '' NOT NULL,
	`diff_stat` text DEFAULT '' NOT NULL,
	`diff` text DEFAULT '' NOT NULL,
	`commit_log` text DEFAULT '' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`usage_approximate` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`work_run_id`) REFERENCES `work_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`backlog_item_id`) REFERENCES `backlog_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `work_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`work_run_id` text NOT NULL,
	`work_item_run_id` text,
	`kind` text NOT NULL,
	`tool_name` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`work_run_id`) REFERENCES `work_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_item_run_id`) REFERENCES `work_item_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `work_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`sprint_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`container_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`sprint_id`) REFERENCES `sprints`(`id`) ON UPDATE no action ON DELETE cascade
);
