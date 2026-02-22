ALTER TABLE "unprice_user" ADD COLUMN "onboarding_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_user" ADD COLUMN "onboarding_completed_at" timestamp;