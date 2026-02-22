CREATE TABLE `usagelimiter_v2_report_usage_aggregates` (
	`bucket_start` integer NOT NULL,
	`bucket_size_seconds` integer NOT NULL,
	`feature_slug` text NOT NULL,
	`report_usage_count` integer DEFAULT 0 NOT NULL,
	`limit_exceeded_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `bucket_size_seconds`, `feature_slug`)
);
--> statement-breakpoint
CREATE INDEX `report_usage_aggregates_bucket_idx` ON `usagelimiter_v2_report_usage_aggregates` (`bucket_size_seconds`,`bucket_start`);--> statement-breakpoint
CREATE TABLE `usagelimiter_v2_usage_aggregates` (
	`bucket_start` integer NOT NULL,
	`bucket_size_seconds` integer NOT NULL,
	`feature_slug` text NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`total_usage` numeric DEFAULT '0' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `bucket_size_seconds`, `feature_slug`)
);
--> statement-breakpoint
CREATE INDEX `usage_aggregates_bucket_idx` ON `usagelimiter_v2_usage_aggregates` (`bucket_size_seconds`,`bucket_start`);--> statement-breakpoint
CREATE TABLE `usagelimiter_v2_usage_records` (
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
	`cost` numeric,
	`rate_amount` numeric,
	`rate_currency` text,
	`entitlement_id` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`country` text DEFAULT 'UNK',
	`region` text DEFAULT 'UNK',
	`action` text,
	`key_id` text
);
--> statement-breakpoint
CREATE INDEX `usage_records_feature_idx` ON `usagelimiter_v2_usage_records` (`feature_slug`);--> statement-breakpoint
CREATE INDEX `usage_records_timestamp_idx` ON `usagelimiter_v2_usage_records` (`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_idempotence_key_idx` ON `usagelimiter_v2_usage_records` (`idempotence_key`);--> statement-breakpoint
CREATE TABLE `usagelimiter_v2_verification_aggregates` (
	`bucket_start` integer NOT NULL,
	`bucket_size_seconds` integer NOT NULL,
	`feature_slug` text NOT NULL,
	`verification_count` integer DEFAULT 0 NOT NULL,
	`allowed_count` integer DEFAULT 0 NOT NULL,
	`denied_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `bucket_size_seconds`, `feature_slug`)
);
--> statement-breakpoint
CREATE INDEX `verification_aggregates_bucket_idx` ON `usagelimiter_v2_verification_aggregates` (`bucket_size_seconds`,`bucket_start`);--> statement-breakpoint
CREATE TABLE `usagelimiter_v2_verifications` (
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
	`usage` numeric,
	`remaining` numeric,
	`entitlement_id` text NOT NULL,
	`allowed` integer DEFAULT 0 NOT NULL,
	`country` text DEFAULT 'UNK',
	`region` text DEFAULT 'UNK',
	`action` text,
	`key_id` text
);
--> statement-breakpoint
CREATE INDEX `verifications_feature_idx` ON `usagelimiter_v2_verifications` (`feature_slug`);