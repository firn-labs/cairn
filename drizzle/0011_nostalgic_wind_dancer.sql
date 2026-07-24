INSERT INTO `oidc_accounts` (`user_id`, `provider_id`, `subject`, `created_at`)
SELECT `id`, 'env', `oidc_subject`, `created_at` FROM `users` WHERE `oidc_subject` IS NOT NULL;--> statement-breakpoint
DROP INDEX `users_oidc_subject_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `oidc_subject`;
