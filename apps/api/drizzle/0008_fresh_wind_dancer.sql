ALTER TABLE `unpricedo_v1_verifications` ADD `allowed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_verifications` DROP COLUMN `success`;