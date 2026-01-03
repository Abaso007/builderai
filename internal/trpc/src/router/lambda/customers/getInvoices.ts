import { TRPCError } from "@trpc/server"
import { customerSelectSchema, subscriptionInvoiceSelectSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getInvoices = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      customer: customerSelectSchema.extend({
        invoices: subscriptionInvoiceSelectSchema.array(),
      }),
    })
  )
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const customerWithSubscriptions = await opts.ctx.db.query.customers.findFirst({
      with: {
        invoices: {
          orderBy: (table, { desc }) => [desc(table.dueAt)],
        },
      },
      where: (table, { eq, and }) => and(eq(table.id, customerId), eq(table.projectId, project.id)),
      orderBy: (table, { desc }) => [desc(table.createdAtM)],
    })

    if (!customerWithSubscriptions) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return {
      customer: customerWithSubscriptions,
    }
  })
