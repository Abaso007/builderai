CREATE TYPE "public"."feature_config_types" AS ENUM('feature', 'addon');--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD COLUMN "feature_config_type" "feature_config_types" DEFAULT 'feature' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" DROP COLUMN "type";--> statement-breakpoint
DROP TYPE "public"."feature_version_types";