ALTER TABLE "unprice_features" ADD COLUMN "unit_of_measure" varchar(24) DEFAULT 'units' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD COLUMN "unit_of_measure" varchar(24) DEFAULT 'units' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_entitlements" ADD COLUMN "unit_of_measure" varchar(24) DEFAULT 'units' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_features" DROP COLUMN "unit";