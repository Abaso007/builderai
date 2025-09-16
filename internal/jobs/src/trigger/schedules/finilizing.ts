import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { finilizeTask } from "../tasks/finilize"

export const finilizingSchedule = schedules.task({
  id: "invoice.finilizing",
  // if dev then every 5 minutes in dev mode
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // find all subscriptions phases that are currently in trial and the trial ends at is in the past
    const subscriptions = await db.query.subscriptions.findMany({
      where: (subscription, ops) =>
        ops.and(
          ops.eq(subscription.active, true),
          ops.notInArray(subscription.status, ["canceled", "expired"]),
          ops.lte(subscription.currentCycleEndAt, now)
        ),
    })

    if (subscriptions.length === 0) {
      return {
        subscriptionIds: [],
      }
    }

    // trigger handles concurrency
    await finilizeTask.batchTrigger(
      subscriptions.map((s) => ({
        payload: {
          projectId: s.projectId,
          subscriptionId: s.id,
          now,
        },
      }))
    )

    logger.info(`Found ${subscriptions.length} subscriptions for finilizing`)

    return {
      subscriptionIds: subscriptions.map((s) => s.id),
    }
  },
})
