CREATE TYPE "public"."merging_policy" AS ENUM('sum', 'max', 'min', 'replace');--> statement-breakpoint
CREATE TYPE "public"."grant_type" AS ENUM('subscription', 'manual', 'promotion', 'trial');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('project', 'plan', 'plan_version', 'customer');--> statement-breakpoint
CREATE TABLE "unprice_entitlements" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"feature_slug" varchar(64) NOT NULL,
	"feature_type" "feature_types" NOT NULL,
	"reset_config" json,
	"aggregation_method" "aggregation_method" NOT NULL,
	"effective_at" bigint NOT NULL,
	"expires_at" bigint,
	"limit" integer,
	"hard_limit" boolean DEFAULT false NOT NULL,
	"timezone" varchar(32) DEFAULT 'UTC' NOT NULL,
	"current_cycle_usage" numeric DEFAULT '0' NOT NULL,
	"accumulated_usage" numeric DEFAULT '0' NOT NULL,
	"merging_policy" "merging_policy" DEFAULT 'sum' NOT NULL,
	"computed_at" bigint NOT NULL,
	"next_revalidate_at" bigint NOT NULL,
	"last_sync_at" bigint NOT NULL,
	"version" varchar(64) DEFAULT '' NOT NULL,
	"grants" json DEFAULT '[]'::json NOT NULL,
	"metadata" json,
	CONSTRAINT "pk_entitlement" PRIMARY KEY("id","project_id"),
	CONSTRAINT "unique_subject_feature" UNIQUE("project_id","customer_id","feature_slug","effective_at","expires_at","version")
);
--> statement-breakpoint
CREATE TABLE "unprice_grants" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"feature_plan_version_id" varchar(36) NOT NULL,
	"type" "grant_type" NOT NULL,
	"subscription_item_id" varchar(36),
	"subject_type" "subject_type" NOT NULL,
	"subject_id" varchar(36) NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"effective_at" bigint NOT NULL,
	"expires_at" bigint,
	"deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"limit" integer,
	"hard_limit" boolean DEFAULT false NOT NULL,
	"units" integer,
	"metadata" json,
	CONSTRAINT "pk_grant" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
DROP TABLE "unprice_customer_entitlements" CASCADE;--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD CONSTRAINT "unprice_entitlements_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD CONSTRAINT "project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD CONSTRAINT "customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "unprice_grants_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "feature_plan_version_id_fkey" FOREIGN KEY ("feature_plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions_features"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_entitlements_subject_feature_computed" ON "unprice_entitlements" USING btree ("project_id","customer_id","feature_slug","computed_at");--> statement-breakpoint
CREATE INDEX "idx_entitlements_version" ON "unprice_entitlements" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "idx_grants_subject_feature_effective" ON "unprice_grants" USING btree ("project_id","subject_id","subject_type","feature_plan_version_id","effective_at","expires_at") WHERE not "unprice_grants"."deleted";--> statement-breakpoint
CREATE INDEX "idx_grants_feature_version_effective" ON "unprice_grants" USING btree ("project_id","feature_plan_version_id","effective_at","expires_at");