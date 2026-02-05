ALTER TABLE `usagelimiter_v1_usage_records` ADD `country` text DEFAULT 'UNK';--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_usage_records` ADD `region` text DEFAULT 'UNK';--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_usage_records` ADD `action` text;--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_usage_records` ADD `resource` text;--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_usage_records` ADD `key_id` text;--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_verifications` ADD `country` text DEFAULT 'UNK';--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_verifications` ADD `region` text DEFAULT 'UNK';--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_verifications` ADD `action` text;--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_verifications` ADD `resource` text;--> statement-breakpoint
ALTER TABLE `usagelimiter_v1_verifications` ADD `key_id` text;