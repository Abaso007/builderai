ALTER TABLE "unprice_customer_entitlements" DROP CONSTRAINT "customer_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" DROP CONSTRAINT "subscription_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ALTER COLUMN "billing_config" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" ALTER COLUMN "billing_config" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;