import { TRPCError } from "@trpc/server"
import { GrantService } from "@unprice/services/grants"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const test = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .mutation(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const grantService = new GrantService(opts.ctx)

    const entitlements = await grantService.computeEntitlementsForCustomer({
      customerId,
      projectId: project.id,
      // TODO: remove this
      now: 1764630000000 + 1000 * 60,
    })

    if (entitlements.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: entitlements.err.message,
      })
    }

    return {
      entitlements: entitlements.val,
    }
  })
