ALTER TABLE "unprice_entitlements" DROP CONSTRAINT "unique_subject_feature";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP CONSTRAINT "subscription_item_id_fkey";
--> statement-breakpoint
DROP INDEX "idx_entitlements_subject_feature_computed";--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD COLUMN "grant_id" varchar(36);--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD COLUMN "allow_overage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD COLUMN "auto_renew" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD COLUMN "allow_overage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD COLUMN "anchor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_entitlements" DROP COLUMN "hard_limit";--> statement-breakpoint
ALTER TABLE "unprice_entitlements" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "subscription_item_id";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "hard_limit";--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD CONSTRAINT "unique_subject_feature" UNIQUE("project_id","customer_id","feature_slug");--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "unique_grant" UNIQUE("project_id","subject_id","subject_type","feature_plan_version_id","type","effective_at","expires_at");