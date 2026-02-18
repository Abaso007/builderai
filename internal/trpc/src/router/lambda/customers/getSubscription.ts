import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

type CustomerSubscriptionResult = Awaited<
  ReturnType<typeof unprice.customers.getSubscription>
>["result"]

export const getSubscription = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      subscription: z.custom<CustomerSubscriptionResult | null>(),
    })
  )
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const customer = await opts.ctx.db.query.customers.findFirst({
      where: (table, { and, eq }) => and(eq(table.id, customerId), eq(table.projectId, project.id)),
      columns: {
        id: true,
      },
    })

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    const { result } = await unprice.customers.getSubscription(customerId)

    return {
      subscription: result ?? null,
    }
  })
