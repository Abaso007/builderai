import { SubscriptionService } from "#/services/subscriptions"
import { protectedProjectProcedure } from "#/trpc"
import { TRPCError } from "@trpc/server"
import { subscriptionPhaseSelectSchema } from "@unprice/db/validators"
import { z } from "zod"

export const updatePhase = protectedProjectProcedure
  .input(subscriptionPhaseSelectSchema)
  .output(z.object({ phase: subscriptionPhaseSelectSchema }))
  .mutation(async (opts) => {
    const projectId = opts.ctx.project.id

    const subscriptionService = new SubscriptionService(opts.ctx)

    const { err, val } = await subscriptionService.updatePhase({
      input: opts.input,
      projectId,
      subscriptionId: opts.input.subscriptionId,
      now: Date.now(),
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      phase: val,
    }
  })
