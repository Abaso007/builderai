CREATE TYPE "public"."overage_strategy" AS ENUM('none', 'last-call', 'always');--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD COLUMN "overage_strategy" "overage_strategy" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD COLUMN "overage_strategy" "overage_strategy" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" DROP COLUMN "allow_overage";--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" DROP COLUMN "notify_usage_threshold";--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" DROP COLUMN "hidden";--> statement-breakpoint
ALTER TABLE "unprice_entitlements" DROP COLUMN "allow_overage";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "allow_overage";