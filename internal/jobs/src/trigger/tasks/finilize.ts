import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { createContext } from "./context"

export const finilizeTask = task({
  id: "invoice.finilize.task",
  retry: {
    maxAttempts: 1,
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
        api: "jobs.invoice.finilize",
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)

    const finalizeInvoiceResult = await subscriptionService.finalizeInvoice({
      projectId,
      subscriptionId,
      now,
    })

    if (finalizeInvoiceResult.err) {
      throw finalizeInvoiceResult.err
    }

    return {
      status: finalizeInvoiceResult.val.map((r) => r.status).join(","),
      subscriptionId,
      projectId,
      now,
    }
  },
})
