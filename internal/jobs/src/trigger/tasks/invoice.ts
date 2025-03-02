import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/api/services/subscriptions"
import { createContext } from "./context"

export const invoiceTask = task({
  id: "subscription.phase.invoice",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
      phaseId,
    }: {
      subscriptionId: string
      projectId: string
      now: number
      phaseId: string
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
        api: "jobs.subscription.phase.invoice",
        phaseId,
      },
    })

    const subscriptionService = new SubscriptionService(context)

    // init phase machine
    const initPhaseMachineResult = await subscriptionService.initPhaseMachines({
      subscriptionId,
      projectId,
    })

    if (initPhaseMachineResult.err) {
      throw initPhaseMachineResult.err
    }

    console.info("Invoicing subscription", {
      subscriptionId,
      projectId,
      now,
      phaseId,
    })

    // TODO: invoice the subscription
    return true
  },
})
