DROP INDEX "invoice_items_external_id_unique";--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD COLUMN "item_provider_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_items_item_provider_id_unique" ON "unprice_invoice_items" USING btree ("project_id","invoice_id","item_provider_id") WHERE "unprice_invoice_items"."item_provider_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" DROP COLUMN "external_id";