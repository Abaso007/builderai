import { TRPCError } from "@trpc/server"
import {
  customerSelectSchema,
  featureSelectBaseSchema,
  invoiceItemSelectSchema,
  planSelectBaseSchema,
  planVersionFeatureSelectBaseSchema,
  planVersionSelectBaseSchema,
  selectBillingPeriodSchema,
  subscriptionInvoiceSelectSchema,
  subscriptionSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getInvoiceById = protectedProjectProcedure
  .input(
    z.object({
      invoiceId: z.string(),
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      invoice: subscriptionInvoiceSelectSchema.extend({
        customer: customerSelectSchema,
        subscription: subscriptionSelectSchema,
        invoiceItems: invoiceItemSelectSchema
          .extend({
            billingPeriod: selectBillingPeriodSchema.nullable(),
            featurePlanVersion: planVersionFeatureSelectBaseSchema
              .extend({
                feature: featureSelectBaseSchema,
                planVersion: planVersionSelectBaseSchema.extend({
                  plan: planSelectBaseSchema,
                }),
              })
              .nullable(),
          })
          .array(),
      }),
    })
  )
  .query(async (opts) => {
    const { invoiceId, customerId } = opts.input
    const { project } = opts.ctx

    const invoice = await opts.ctx.db.query.invoices.findFirst({
      with: {
        customer: true,
        subscription: true,
        invoiceItems: {
          with: {
            featurePlanVersion: {
              with: {
                planVersion: {
                  with: {
                    plan: true,
                  },
                },
                feature: true,
              },
            },
            billingPeriod: true,
          },
        },
      },
      where: (table, { eq, and }) =>
        and(
          eq(table.id, invoiceId),
          eq(table.customerId, customerId),
          eq(table.projectId, project.id)
        ),
    })

    if (!invoice) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Invoice not found",
      })
    }

    return {
      invoice: invoice,
    }
  })
