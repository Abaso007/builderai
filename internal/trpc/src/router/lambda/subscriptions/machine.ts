import { TRPCError } from "@trpc/server"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const machine = protectedProjectProcedure
  .input(
    z.object({ event: z.enum(["invoice", "renew", "billing_period"]), subscriptionId: z.string() })
  )
  .output(z.object({ status: z.string() }))
  .mutation(async ({ input, ctx }) => {
    const projectId = ctx.project.id

    const subscriptionService = new SubscriptionService(ctx)

    switch (input.event) {
      case "invoice": {
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
      }

      case "renew": {
        const { err, val } = await subscriptionService.renewSubscription({
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
      }

      case "billing_period": {
        const { err, val } = await subscriptionService.generateBillingPeriods({
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
      }

      default:
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid event",
        })
    }
  })
