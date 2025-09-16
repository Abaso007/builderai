ALTER TABLE "unprice_invoice_items" DROP CONSTRAINT "invoice_items_billing_period_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" DROP CONSTRAINT "invoice_items_subscription_item_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" DROP CONSTRAINT "invoice_items_feature_plan_version_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_billing_period_id_fkey" FOREIGN KEY ("billing_period_id","project_id") REFERENCES "public"."unprice_billing_periods"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_feature_plan_version_id_fkey" FOREIGN KEY ("feature_plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions_features"("id","project_id") ON DELETE cascade ON UPDATE no action;