CREATE TABLE `idempotency_keys` (
	`eventId` text PRIMARY KEY NOT NULL,
	`createdAt` integer NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meter_facts_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meter_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` real NOT NULL
);
