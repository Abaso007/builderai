CREATE TABLE `usagelimiter_v1_report_usage_aggregates` (
	`bucket_start` integer NOT NULL,
	`bucket_size_seconds` integer NOT NULL,
	`feature_slug` text NOT NULL,
	`report_usage_count` integer DEFAULT 0 NOT NULL,
	`limit_exceeded_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`bucket_start`, `bucket_size_seconds`, `feature_slug`)
);
--> statement-breakpoint
CREATE INDEX `report_usage_aggregates_bucket_idx` ON `usagelimiter_v1_report_usage_aggregates` (`bucket_size_seconds`,`bucket_start`);
