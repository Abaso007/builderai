import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

type CustomerEntitlementsResult = NonNullable<
  Awaited<ReturnType<typeof unprice.customers.getEntitlements>>["result"]
>

export const getEntitlements = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      entitlements: z.custom<CustomerEntitlementsResult>(),
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

    const { result } = await unprice.customers.getEntitlements(customerId)

    return {
      entitlements: result ?? [],
    }
  })
