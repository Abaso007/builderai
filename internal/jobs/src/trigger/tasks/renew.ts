import { task } from "@trigger.dev/sdk/v3"
import { logger } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { unprice } from "src/unprice"
import { createContext } from "./context"

export const renewTask = task({
  id: "subscription.renew.task",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
      customerId,
    }: {
      subscriptionId: string
      projectId: string
      now: number
      customerId: string
    },
    { ctx }
  ) => {
    const context = await createContext({
      taskId: ctx.task.id,
      subscriptionId,
      projectId,
      defaultFields: {
        subscriptionId,
        projectId,
        customerId,
        api: "jobs.subscription.renew.task",
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)

    const renewResult = await subscriptionService.renewSubscription({
      subscriptionId,
      projectId,
      now,
    })

    if (renewResult.err) {
      throw renewResult.err
    }

    // reset entitlements after the subscription is renewed
    const { error } = await unprice.customers.resetEntitlements({
      customerId,
      projectId,
    })

    if (error) {
      logger.error(`error resetting entitlements: ${error.message}`, {
        error: error,
        customerId,
        projectId,
      })
    }

    return {
      status: renewResult.val.status,
      subscriptionId,
      projectId,
      customerId,
      now,
    }
  },
})
