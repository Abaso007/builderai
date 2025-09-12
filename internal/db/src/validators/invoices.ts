import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { invoices } from "../schema/invoices"

export const subscriptionInvoiceSelectSchema = createSelectSchema(invoices)

export type SubscriptionInvoice = typeof invoices.$inferSelect

export const reasonCreditSchema = z.enum([
  "downgrade_in_advance",
  "downgrade_arrear",
  "invoice_total_overdue",
])
export const invoiceCreditMetadataSchema = z.object({
  reason: reasonCreditSchema.optional().describe("Reason for the invoice credit"),
  note: z.string().optional().describe("Note about the invoice credit"),
})
