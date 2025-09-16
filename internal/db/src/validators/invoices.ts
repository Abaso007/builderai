import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { invoiceItems, invoices } from "../schema/invoices"
import { featureSelectBaseSchema } from "./features"
import { planVersionFeatureSelectBaseSchema } from "./planVersionFeatures"

export const subscriptionInvoiceSelectSchema = createSelectSchema(invoices)

export const invoiceItemSelectSchema = createSelectSchema(invoiceItems)
export const invoiceItemExtendedSelectSchema = invoiceItemSelectSchema.extend({
  featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
    feature: featureSelectBaseSchema,
  }),
})

export const reasonCreditSchema = z.enum([
  "downgrade_in_advance",
  "downgrade_arrear",
  "invoice_total_overdue",
])
export const invoiceCreditMetadataSchema = z.object({
  reason: reasonCreditSchema.optional().describe("Reason for the invoice credit"),
  note: z.string().optional().describe("Note about the invoice credit"),
})

export type InvoiceItem = typeof invoiceItems.$inferSelect
export type InvoiceItemExtended = z.infer<typeof invoiceItemExtendedSelectSchema>
export type SubscriptionInvoice = typeof invoices.$inferSelect
