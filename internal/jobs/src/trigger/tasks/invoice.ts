import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { createContext } from "./context"

export const invoiceTask = task({
  id: "subscription.phase.invoice",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
    }: {
      subscriptionId: string
      projectId: string
      now: number
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
        api: "jobs.subscription.invoice",
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)

    // init phase machine
    const invoiceResult = await subscriptionService.invoiceSubscription({
      subscriptionId,
      projectId,
      now,
    })

    if (invoiceResult.err) {
      throw invoiceResult.err
    }

    return {
      status: invoiceResult.val.status,
      subscriptionId,
    }
  },
})
