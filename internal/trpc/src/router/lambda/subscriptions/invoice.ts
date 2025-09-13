import { TRPCError } from "@trpc/server"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const invoice = protectedProjectProcedure
  .input(z.object({ subscriptionId: z.string() }))
  .output(z.object({ status: z.string() }))
  .mutation(async ({ input, ctx }) => {
    const projectId = ctx.project.id

    const subscriptionService = new SubscriptionService(ctx)

    const { err, val } = await subscriptionService.invoiceSubscription({
      subscriptionId: input.subscriptionId,
      projectId,
      now: Date.now(),
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      status: val.status,
    }
  })
