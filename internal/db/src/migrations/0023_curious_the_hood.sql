-- The new ENUM type definition (this is correct)
CREATE TYPE "public"."subscription_status_v2" AS ENUM('idle', 'renewing', 'changing', 'canceling', 'expiring', 'invoicing', 'invoiced', 'active', 'trialing', 'canceled', 'expired', 'past_due');

--> statement-breakpoint

-- STEP 1: Temporarily drop the default value
ALTER TABLE "unprice_subscriptions" ALTER COLUMN "status" DROP DEFAULT;

--> statement-breakpoint

-- STEP 2: Now, change the column type (your original command)
ALTER TABLE "unprice_subscriptions" ALTER COLUMN "status" SET DATA TYPE subscription_status_v2 USING status::text::subscription_status_v2;

--> statement-breakpoint

-- STEP 3: Add the default back, using the NEW enum type
-- IMPORTANT: Replace 'idle' with whatever your desired default is.
ALTER TABLE "unprice_subscriptions" ALTER COLUMN "status" SET DEFAULT 'idle'::subscription_status_v2;

--> statement-breakpoint

CREATE UNIQUE INDEX "invoices_period_unique" ON "unprice_invoices" USING btree ("project_id","subscription_id","subscription_phase_id","customer_id","cycle_start_at_m","cycle_end_at_m");--> statement-breakpoint
CREATE UNIQUE INDEX "phase_sub_window_uq" ON "unprice_subscription_phases" USING btree ("project_id","subscription_id","start_at_m","end_at_m");--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" DROP COLUMN "previous_cycle_start_at_m";--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" DROP COLUMN "previous_cycle_end_at_m";--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" DROP COLUMN "invoice_at_m";--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" DROP COLUMN "renew_at_m";--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" DROP COLUMN "last_renew_at_m";--> statement-breakpoint
ALTER TABLE "unprice_subscriptions" DROP COLUMN "last_invoice_at_m";--> statement-breakpoint
DROP TYPE "public"."subscription_status";