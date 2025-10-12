ALTER TABLE "unprice_invoice_items" ALTER COLUMN "proration_factor" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ALTER COLUMN "proration_factor" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_billing_periods" DROP COLUMN "proration_factor";