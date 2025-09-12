import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { createContext } from "./context"

export const renewTask = task({
  id: "subscription.phase.renew",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      subscriptionId,
      phaseId,
      projectId,
      now,
    }: {
      subscriptionId: string
      phaseId: string
      projectId: string
      now: number
    },
    { ctx }
  ) => {
    const context = await createContext({
      taskId: ctx.task.id,
      subscriptionId,
      projectId,
      phaseId,
      defaultFields: {
        subscriptionId,
        projectId,
        api: "jobs.subscription.phase.renew",
        phaseId,
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)

    const renewResult = await subscriptionService.endTrial({
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
      phaseId,
    }
  },
})
