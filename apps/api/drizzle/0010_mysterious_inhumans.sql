PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_unpricedo_v1_usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotenceKey` text NOT NULL,
	`requestId` text NOT NULL,
	`featureSlug` text NOT NULL,
	`customerId` text NOT NULL,
	`projectId` text NOT NULL,
	`timestamp` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`usage` numeric,
	`metadata` text,
	`deleted` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_unpricedo_v1_usage_records`("id", "idempotenceKey", "requestId", "featureSlug", "customerId", "projectId", "timestamp", "createdAt", "usage", "metadata", "deleted") SELECT "id", "idempotenceKey", "requestId", "featureSlug", "customerId", "projectId", "timestamp", "createdAt", "usage", "metadata", "deleted" FROM `unpricedo_v1_usage_records`;--> statement-breakpoint
DROP TABLE `unpricedo_v1_usage_records`;--> statement-breakpoint
ALTER TABLE `__new_unpricedo_v1_usage_records` RENAME TO `unpricedo_v1_usage_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `usage_records_feature_idx` ON `unpricedo_v1_usage_records` (`featureSlug`);--> statement-breakpoint
CREATE INDEX `usage_records_timestamp_idx` ON `unpricedo_v1_usage_records` (`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_idempotence_key_idx` ON `unpricedo_v1_usage_records` (`idempotenceKey`);