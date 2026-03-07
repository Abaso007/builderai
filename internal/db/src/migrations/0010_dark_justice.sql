CREATE TABLE "unprice_events" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"available_properties" json,
	CONSTRAINT "events_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_entitlements" DROP CONSTRAINT "unique_subject_feature";--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" DROP CONSTRAINT "billing_periods_grant_id_fkey";
--> statement-breakpoint
DROP INDEX "idx_entitlements_version";--> statement-breakpoint
ALTER TABLE "unprice_features" ADD COLUMN "meter_config" json;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD COLUMN "meter_config" json;--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_events" ADD CONSTRAINT "unprice_events_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_event_project_slug" ON "unprice_events" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_current_subject_feature" ON "unprice_entitlements" USING btree ("project_id","customer_id","feature_slug") WHERE "unprice_entitlements"."is_current" = $1;--> statement-breakpoint
CREATE INDEX "idx_entitlements_edge_cache" ON "unprice_entitlements" USING btree ("project_id","customer_id","feature_slug","effective_at");--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" DROP COLUMN "grant_id";