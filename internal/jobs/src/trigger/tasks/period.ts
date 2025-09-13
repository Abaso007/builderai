import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { createContext } from "./context"

export const periodTask = task({
  id: "subscription.period.task",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      projectId,
      now,
      subscriptionId,
    }: {
      projectId: string
      now: number
      subscriptionId: string
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
        api: "jobs.subscription.period.task",
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)

    // init phase machine
    const periodResult = await subscriptionService.generateBillingPeriods({
      subscriptionId,
      projectId,
      now,
    })

    if (periodResult.err) {
      throw periodResult.err
    }

    return {
      status: periodResult.val.status,
      subscriptionId,
      projectId,
      now,
    }
  },
})
