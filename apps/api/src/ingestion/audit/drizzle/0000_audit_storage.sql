CREATE TABLE `ingestion_audit` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`canonical_audit_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`rejection_reason` text,
	`result_json` text,
	`audit_payload_json` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_audit_canonical_audit_id_unique` ON `ingestion_audit` (`canonical_audit_id`);--> statement-breakpoint
CREATE INDEX `idx_ingestion_audit_unpublished` ON `ingestion_audit` (`first_seen_at`) WHERE "ingestion_audit"."published_at" IS NULL;