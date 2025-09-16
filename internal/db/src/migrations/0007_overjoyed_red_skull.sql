ALTER TABLE "unprice_invoices" DROP CONSTRAINT "invoices_subscription_phase_id_fkey";
--> statement-breakpoint
DROP INDEX "invoices_period_idx";--> statement-breakpoint
DROP INDEX "invoices_statement_key_idx";--> statement-breakpoint
CREATE INDEX "invoices_period_idx" ON "unprice_invoices" USING btree ("project_id","subscription_id","customer_id","statement_start_at_m","statement_end_at_m");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_statement_key_idx" ON "unprice_invoices" USING btree ("project_id","subscription_id","customer_id","statement_key");--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "subscription_phase_id";