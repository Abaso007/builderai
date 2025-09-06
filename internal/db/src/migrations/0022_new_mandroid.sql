DROP INDEX "valid_from_index";--> statement-breakpoint
DROP INDEX "valid_to_index";--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ALTER COLUMN "subscription_phase_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD COLUMN "current_cycle_usage" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" DROP COLUMN "usage";--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" DROP COLUMN "valid_from";--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" DROP COLUMN "valid_to";--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" DROP COLUMN "buffer_period_days";