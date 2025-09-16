ALTER TYPE "public"."invoice_item_kind" ADD VALUE 'trial';--> statement-breakpoint
DROP INDEX "invoices_period_unique";--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD COLUMN "when_to_bill" "when_to_bill" DEFAULT 'pay_in_advance' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD COLUMN "invoice_at_m" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD COLUMN "statement_key" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "statement_date_string" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "statement_key" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "statement_start_at_m" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "statement_end_at_m" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_credit_grants" ADD CONSTRAINT "credit_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_periods_bill_at_idx" ON "unprice_billing_periods" USING btree ("project_id","status","invoice_at_m");--> statement-breakpoint
CREATE INDEX "billing_periods_statement_idx" ON "unprice_billing_periods" USING btree ("project_id","subscription_id","statement_key");--> statement-breakpoint
CREATE INDEX "invoices_period_idx" ON "unprice_invoices" USING btree ("project_id","subscription_id","subscription_phase_id","customer_id","statement_start_at_m","statement_end_at_m");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_statement_key_idx" ON "unprice_invoices" USING btree ("project_id","subscription_id","subscription_phase_id","customer_id","statement_key");--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "cycle_start_at_m";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "cycle_end_at_m";