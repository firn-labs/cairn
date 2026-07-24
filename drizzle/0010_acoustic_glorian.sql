CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `oidc_accounts` (
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`provider_id`, `subject`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_ciphertext` text DEFAULT '' NOT NULL,
	`scopes` text DEFAULT 'openid profile email' NOT NULL,
	`groups_claim` text DEFAULT 'groups' NOT NULL,
	`member_group` text DEFAULT '' NOT NULL,
	`viewer_group` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `is_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `users` SET `is_admin` = 1 WHERE `id` = (SELECT `id` FROM `users` ORDER BY `created_at` ASC, `id` ASC LIMIT 1);