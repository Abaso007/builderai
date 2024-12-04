import { TRPCError } from "@trpc/server"
import { subscriptionPhaseSelectSchema } from "@unprice/db/validators"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { z } from "zod"
import { protectedProjectProcedure } from "../../../trpc"

export const updatePhase = protectedProjectProcedure
  .input(subscriptionPhaseSelectSchema)
  .output(z.object({ phase: subscriptionPhaseSelectSchema }))
  .mutation(async (opts) => {
    const projectId = opts.ctx.project.id

    const subscriptionService = new SubscriptionService({
      db: opts.ctx.db,
      cache: opts.ctx.cache,
      metrics: opts.ctx.metrics,
      logger: opts.ctx.logger,
      waitUntil: opts.ctx.waitUntil,
      analytics: opts.ctx.analytics,
    })

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