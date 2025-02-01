import { protectedApiOrActiveProjectProcedure } from "#/trpc"
import { featureGuard } from "#/utils/feature-guard"
import { reportUsageFeature } from "#/utils/shared"
import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { customerSelectSchema } from "@unprice/db/validators"
import { z } from "zod"

export const remove = protectedApiOrActiveProjectProcedure
  .meta({
    span: "customers.remove",
    openapi: {
      method: "POST",
      path: "/edge/customers.remove",
      protect: true,
    },
  })
  .input(customerSelectSchema.pick({ id: true }))
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const { project } = opts.ctx

    const unPriceCustomerId = project.workspace.unPriceCustomerId

    // check if the customer has access to the feature
    await featureGuard({
      customerId: unPriceCustomerId,
      featureSlug: "customers",
      ctx: opts.ctx,
      skipCache: true,
      updateUsage: true,
      isInternal: project.workspace.isInternal,
    })

    const deletedCustomer = await opts.ctx.db
      .delete(schema.customers)
      .where(and(eq(schema.customers.projectId, project.id), eq(schema.customers.id, id)))
      .returning()
      .then((re) => re[0])

    if (!deletedCustomer) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting customer",
      })
    }

    opts.ctx.waitUntil(
      // report usage for the new project in background
      reportUsageFeature({
        customerId: unPriceCustomerId,
        featureSlug: "customers",
        usage: -1, // the deleted project
        ctx: opts.ctx,
        isInternal: project.workspace.isInternal,
      })
    )

    return {
      customer: deletedCustomer,
    }
  })
