import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { createContext } from "./context"

export const billingTask = task({
  id: "invoice.billing.task",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
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
        api: "jobs.invoice.billing",
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)

    const billingResult = await subscriptionService.billingInvoice({
      projectId,
      subscriptionId,
      now,
    })

    if (billingResult.err) {
      throw billingResult.err
    }

    return {
      status: billingResult.val.status,
      subscriptionId,
      projectId,
      now,
    }
  },
})
