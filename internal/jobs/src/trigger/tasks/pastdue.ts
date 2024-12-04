import { task } from "@trigger.dev/sdk/v3"
import { db } from "@unprice/db"
import { ConsoleLogger } from "@unprice/logging"
import { NoopMetrics } from "@unprice/services/metrics"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { Analytics } from "@unprice/tinybird"
import { env } from "../../env.mjs"

export const pastDueTask = task({
  id: "subscription.pastdue",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
      pastDueAt,
      phaseId,
      invoiceId,
    }: {
      subscriptionId: string
      projectId: string
      now: number
      pastDueAt?: number
      phaseId: string
      invoiceId: string
    },
    { ctx }
  ) => {
    const tinybird = new Analytics({
      emit: true,
      tinybirdToken: env.TINYBIRD_TOKEN,
    })

    const logger = new ConsoleLogger({
      requestId: ctx.task.id,
      defaultFields: {
        subscriptionId,
        phaseId,
        invoiceId,
        projectId,
        api: "jobs.invoice.pastdue",
      },
    })

    const subscriptionService = new SubscriptionService({
      db: db,
      // all calls made to the database
      cache: undefined,
      metrics: new NoopMetrics(),
      logger: logger,
      waitUntil: () => {},
      analytics: tinybird,
    })

    // init phase machine
    const initPhaseMachineResult = await subscriptionService.initPhaseMachines({
      subscriptionId,
      projectId,
    })

    if (initPhaseMachineResult.err) {
      throw initPhaseMachineResult.err
    }

    const result = await subscriptionService.pastDueSubscription({
      now,
      pastDueAt,
      phaseId: phaseId,
      invoiceId: invoiceId,
    })

    // we have to throw if there is an error so the task fails
    if (result.err) {
      throw result.err
    }

    return result.val
  },
})