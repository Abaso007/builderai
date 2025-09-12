import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { createContext } from "./context"

export const periodTask = task({
  id: "subscription.phase.period",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      phaseId,
      projectId,
      now,
      subscriptionId,
    }: {
      phaseId: string
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
        api: "jobs.subscription.phase.period",
        phaseId,
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)

    // init phase machine
    const periodResult = await subscriptionService.createPeriodsForSubscriptionItems({
      phaseId,
      subscriptionId,
      projectId,
      now,
    })

    if (periodResult.err) {
      throw periodResult.err
    }

    return {
      cyclesCreated: periodResult.val.cyclesCreated,
      subscriptionId,
      projectId,
      now,
      phaseId,
    }
  },
})
