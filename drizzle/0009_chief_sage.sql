CREATE TABLE `executor_credentials` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`user_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `teams` ADD `executor` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `executor_config` text DEFAULT '{}' NOT NULL;