import { task } from "@trigger.dev/sdk/v3"
import { db } from "@unprice/db"
import { ConsoleLogger } from "@unprice/logging"
import { NoopMetrics } from "@unprice/services/metrics"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { Analytics } from "@unprice/tinybird"
import { env } from "../../env.mjs"

export const cancelTask = task({
  id: "subscription.cancel",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
      cancelAt,
      phaseId,
    }: {
      subscriptionId: string
      projectId: string
      now: number
      cancelAt?: number
      phaseId: string
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
        projectId,
        api: "jobs.subscription.cancel",
        phaseId,
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

    const result = await subscriptionService.cancelSubscription({
      now,
      cancelAt,
      phaseId,
    })

    // we have to throw if there is an error so the task fails
    if (result.err) {
      throw result.err
    }

    return result.val
  },
})
