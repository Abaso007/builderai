ALTER TYPE "public"."aggregation_method" ADD VALUE 'none' BEFORE 'sum';--> statement-breakpoint
ALTER TABLE "unprice_entitlements" DROP COLUMN "current_cycle_usage";--> statement-breakpoint
ALTER TABLE "unprice_entitlements" DROP COLUMN "accumulated_usage";--> statement-breakpoint
ALTER TABLE "unprice_entitlements" DROP COLUMN "last_sync_at";