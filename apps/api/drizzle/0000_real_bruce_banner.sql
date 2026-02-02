CREATE TABLE `usagelimiter_v1_usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotence_key` text NOT NULL,
	`request_id` text NOT NULL,
	`feature_slug` text NOT NULL,
	`customer_id` text NOT NULL,
	`project_id` text NOT NULL,
	`timestamp` integer NOT NULL,
	`created_at` integer NOT NULL,
	`usage` numeric,
	`metadata` text,
	`deleted` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_records_feature_idx` ON `usagelimiter_v1_usage_records` (`feature_slug`);--> statement-breakpoint
CREATE INDEX `usage_records_timestamp_idx` ON `usagelimiter_v1_usage_records` (`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_idempotence_key_idx` ON `usagelimiter_v1_usage_records` (`idempotence_key`);--> statement-breakpoint
CREATE TABLE `usagelimiter_v1_verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`project_id` text NOT NULL,
	`denied_reason` text,
	`timestamp` integer NOT NULL,
	`created_at` integer NOT NULL,
	`latency` numeric,
	`feature_slug` text NOT NULL,
	`customer_id` text NOT NULL,
	`metadata` text,
	`allowed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_feature_idx` ON `usagelimiter_v1_verifications` (`feature_slug`);