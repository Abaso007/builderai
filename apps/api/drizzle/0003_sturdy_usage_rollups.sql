CREATE TABLE `usagelimiter_v1_usage_aggregates` (
	`bucket_start` integer NOT NULL,
	`bucket_size_seconds` integer NOT NULL,
	`feature_slug` text NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`total_usage` numeric DEFAULT '0' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `bucket_size_seconds`, `feature_slug`)
);
--> statement-breakpoint
CREATE INDEX `usage_aggregates_bucket_idx` ON `usagelimiter_v1_usage_aggregates` (`bucket_size_seconds`,`bucket_start`);
--> statement-breakpoint
CREATE TABLE `usagelimiter_v1_verification_aggregates` (
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
CREATE INDEX `verification_aggregates_bucket_idx` ON `usagelimiter_v1_verification_aggregates` (`bucket_size_seconds`,`bucket_start`);
