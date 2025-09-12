-- The new ENUM type definition (this is correct)
CREATE TYPE "public"."subscription_status_v3" AS ENUM('active', 'trialing', 'canceled', 'expired', 'past_due');--> statement-breakpoint

-- STEP 1: Temporarily drop the default value
ALTER TABLE "unprice_subscriptions" ALTER COLUMN "status" DROP DEFAULT;

--> statement-breakpoint

-- STEP 2: Now, change the column type (your original command)
ALTER TABLE "unprice_subscriptions" ALTER COLUMN "status" SET DATA TYPE subscription_status_v3 USING status::text::subscription_status_v3;

--> statement-breakpoint

-- STEP 3: Add the default back, using the NEW enum type
-- IMPORTANT: Replace 'active' with whatever your desired default is.
ALTER TABLE "unprice_subscriptions" ALTER COLUMN "status" SET DEFAULT 'active'::subscription_status_v3;

--> statement-breakpoint
CREATE TABLE "unprice_subscription_locks" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"subscription_id" varchar(32) NOT NULL,
	"owner_token" varchar(64) NOT NULL,
	"expires_at_m" bigint NOT NULL,
	CONSTRAINT "subscription_locks_pk" PRIMARY KEY("project_id","subscription_id")
);

ALTER TABLE "unprice_subscription_phases" ADD COLUMN "current_cycle_start_at_m" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD COLUMN "current_cycle_end_at_m" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD COLUMN "renew_at_m" bigint DEFAULT 0;--> statement-breakpoint
ALTER TABLE "unprice_subscription_locks" ADD CONSTRAINT "unprice_subscription_locks_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_locks_idx" ON "unprice_subscription_locks" USING btree ("project_id","subscription_id");--> statement-breakpoint
CREATE INDEX "phase_sub_renew_uq" ON "unprice_subscription_phases" USING btree ("project_id","renew_at_m");--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" DROP COLUMN "end_at_m";--> statement-breakpoint
DROP TYPE "public"."subscription_status_v2";