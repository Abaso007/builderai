import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
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

    return {
      status: renewResult.val.status,
      subscriptionId,
      projectId,
      now,
    }
  },
})
