CREATE TYPE "public"."billing_period_status" AS ENUM('pending', 'processing', 'invoiced', 'voided');--> statement-breakpoint
CREATE TYPE "public"."billing_period_type" AS ENUM('normal', 'trial');--> statement-breakpoint
CREATE TYPE "public"."invoice_item_kind" AS ENUM('period', 'tax', 'discount', 'refund', 'adjustment');--> statement-breakpoint
CREATE TABLE "unprice_billing_periods" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"subscription_id" varchar(36) NOT NULL,
	"subscription_phase_id" varchar(36) NOT NULL,
	"subscription_item_id" varchar(36) NOT NULL,
	"status" "billing_period_status" DEFAULT 'pending' NOT NULL,
	"type" "billing_period_type" DEFAULT 'normal' NOT NULL,
	"cycle_start_at_m" bigint NOT NULL,
	"cycle_end_at_m" bigint NOT NULL,
	"processing_at_m" bigint,
	"invoice_id" varchar(36),
	"amount_estimate_cents" integer,
	"proration_factor" double precision,
	"reason" varchar(64),
	CONSTRAINT "billing_periods_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_credit_grants" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"currency" "currency" NOT NULL,
	"payment_providers" "payment_providers" NOT NULL,
	"total_amount" integer NOT NULL,
	"amount_used" integer DEFAULT 0 NOT NULL,
	"expires_at_m" bigint,
	"reason" varchar(64),
	"metadata" json,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "credit_grants_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_invoice_credit_applications" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"invoice_id" varchar(36) NOT NULL,
	"credit_grant_id" varchar(36) NOT NULL,
	"amount_applied" integer NOT NULL,
	CONSTRAINT "invoice_credit_applications_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_invoice_items" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"invoice_id" varchar(36) NOT NULL,
	"billing_period_id" varchar(36),
	"subscription_item_id" varchar(36),
	"feature_plan_version_id" varchar(36),
	"kind" "invoice_item_kind" DEFAULT 'period' NOT NULL,
	"unit_amount_cents" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_subtotal" integer DEFAULT 0 NOT NULL,
	"amount_total" integer DEFAULT 0 NOT NULL,
	"cycle_start_at_m" bigint NOT NULL,
	"cycle_end_at_m" bigint NOT NULL,
	"proration" boolean DEFAULT false NOT NULL,
	"proration_factor" double precision,
	"description" varchar(200),
	"external_id" text,
	CONSTRAINT "invoice_items_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_customer_credits" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "unprice_customer_credits" CASCADE;--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" ALTER COLUMN "billing_config" SET DEFAULT '{}'::json;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD COLUMN "billing_config" json DEFAULT '{}'::json NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "issue_date_m" bigint;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "unprice_billing_periods_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_subscription_phase_id_fkey" FOREIGN KEY ("subscription_phase_id","project_id") REFERENCES "public"."unprice_subscription_phases"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" ADD CONSTRAINT "billing_periods_invoice_id_fkey" FOREIGN KEY ("invoice_id","project_id") REFERENCES "public"."unprice_invoices"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_credit_grants" ADD CONSTRAINT "unprice_credit_grants_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_credit_grants" ADD CONSTRAINT "credit_grants_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_credit_applications" ADD CONSTRAINT "unprice_invoice_credit_applications_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_credit_applications" ADD CONSTRAINT "invoice_credit_applications_invoice_id_fkey" FOREIGN KEY ("invoice_id","project_id") REFERENCES "public"."unprice_invoices"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_credit_applications" ADD CONSTRAINT "invoice_credit_applications_credit_grant_id_fkey" FOREIGN KEY ("credit_grant_id","project_id") REFERENCES "public"."unprice_credit_grants"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "unprice_invoice_items_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id","project_id") REFERENCES "public"."unprice_invoices"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_billing_period_id_fkey" FOREIGN KEY ("billing_period_id","project_id") REFERENCES "public"."unprice_billing_periods"("id","project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_feature_plan_version_id_fkey" FOREIGN KEY ("feature_plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions_features"("id","project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_periods_period_unique" ON "unprice_billing_periods" USING btree ("project_id","subscription_id","subscription_phase_id","subscription_item_id","cycle_start_at_m","cycle_end_at_m");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_items_cycle_unique" ON "unprice_invoice_items" USING btree ("project_id","invoice_id","billing_period_id") WHERE "unprice_invoice_items"."billing_period_id" IS NOT NULL AND "unprice_invoice_items"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_items_external_id_unique" ON "unprice_invoice_items" USING btree ("project_id","invoice_id","external_id") WHERE "unprice_invoice_items"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoice_items_invoice_idx" ON "unprice_invoice_items" USING btree ("project_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_items_cycle_idx" ON "unprice_invoice_items" USING btree ("project_id","billing_period_id");--> statement-breakpoint
CREATE INDEX "invoice_items_sub_item_idx" ON "unprice_invoice_items" USING btree ("project_id","subscription_item_id");--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "previous_cycle_start_at_m";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "previous_cycle_end_at_m";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "prorated";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "customer_credit_id";