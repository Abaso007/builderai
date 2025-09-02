import { task } from "@trigger.dev/sdk/v3"
import { SubscriptionService, type SusbriptionMachineStatus } from "@unprice/services/subscriptions"
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
        now: now.toString(),
      },
    })

    const subscriptionService = new SubscriptionService(context)
    let status: SusbriptionMachineStatus
    let count = 0
    const maxInvoicesPerAttempt = 10

    // we need to do this as many time as needed until the next invoiceAt is in the future
    while (true) {
      count++
      // init phase machine
      const billingInvoiceResult = await subscriptionService.invoiceSubscription({
        subscriptionId,
        projectId,
        now,
      })

      if (billingInvoiceResult.err) {
        throw billingInvoiceResult.err
      }

      // get the subscription
      const subscription = await subscriptionService.getSubscriptionData({
        subscriptionId,
        projectId,
      })

      if (!subscription) {
        throw new Error("Subscription not found after invoicing")
      }

      console.info("Invoicing subscription again", {
        subscriptionId,
        projectId,
        currentInvoiceAt: new Date(subscription.invoiceAt).toISOString(),
        currentBillingCycleStartAt: new Date(subscription.currentCycleStartAt).toISOString(),
        currentBillingCycleEndAt: new Date(subscription.currentCycleEndAt).toISOString(),
      })

      status = billingInvoiceResult.val.status

      if (subscription.invoiceAt > now) {
        console.info("Subscription is not due to be invoiced", {
          subscriptionId,
          projectId,
          currentInvoiceAt: new Date(subscription.invoiceAt).toISOString(),
        })

        break
      }

      if (count > maxInvoicesPerAttempt) {
        break
      }
    }

    console.info("Invoicing subscription finished", {
      subscriptionId,
      projectId,
      status: status,
      count,
      maxInvoicesPerAttempt,
    })

    return {
      status: status,
      count,
    }
  },
})
