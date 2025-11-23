ALTER TABLE `unpricedo_v1_usage_records` ADD `grantId` text NOT NULL;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_usage_records` DROP COLUMN `entitlementId`;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_verifications` ADD `grantId` text NOT NULL;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_verifications` DROP COLUMN `featurePlanVersionId`;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_verifications` DROP COLUMN `subscriptionItemId`;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_verifications` DROP COLUMN `subscriptionPhaseId`;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_verifications` DROP COLUMN `subscriptionId`;--> statement-breakpoint
ALTER TABLE `unpricedo_v1_verifications` DROP COLUMN `entitlementId`;