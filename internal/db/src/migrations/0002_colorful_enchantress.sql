CREATE TYPE "public"."billing_period_status_v1" AS ENUM('pending', 'invoiced', 'voided');--> statement-breakpoint


-- STEP 1: Temporarily drop the default value
ALTER TABLE "unprice_billing_periods" ALTER COLUMN "status" DROP DEFAULT;

--> statement-breakpoint

-- STEP 2: Now, change the column type (your original command)
ALTER TABLE "unprice_billing_periods" ALTER COLUMN "status" SET DATA TYPE billing_period_status_v1 USING status::text::billing_period_status_v1;

--> statement-breakpoint

ALTER TYPE "public"."billing_interval" ADD VALUE 'week' BEFORE 'day';--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" DROP COLUMN "processing_at_m";--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" DROP COLUMN "proration";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "type";--> statement-breakpoint
DROP TYPE "public"."billing_period_status";--> statement-breakpoint
DROP TYPE "public"."invoice_type";