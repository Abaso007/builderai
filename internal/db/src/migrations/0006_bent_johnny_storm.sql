ALTER TABLE "unprice_features" ADD COLUMN "unit" varchar(24) DEFAULT 'units' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD COLUMN "customer_id" varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD COLUMN "name" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_grant_id_fkey" FOREIGN KEY ("grant_id","project_id") REFERENCES "public"."unprice_grants"("id","project_id") ON DELETE cascade ON UPDATE no action;