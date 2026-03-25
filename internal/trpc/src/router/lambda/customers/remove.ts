import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const remove = protectedProjectProcedure
  .meta({
    span: "customers.remove",
    openapi: {
      method: "POST",
      path: "/lambda/customers.remove",
      protect: true,
    },
  })
  .input(customerSelectSchema.pick({ id: true }))
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const { project } = opts.ctx
    const _unPriceCustomerId = project.workspace.unPriceCustomerId

    const deletedCustomer = await opts.ctx.db
      .delete(customers)
      .where(and(eq(customers.projectId, project.id), eq(customers.id, id)))
      .returning()
      .then((re) => re[0])

    if (!deletedCustomer) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting customer",
      })
    }

    return {
      customer: deletedCustomer,
    }
  })
