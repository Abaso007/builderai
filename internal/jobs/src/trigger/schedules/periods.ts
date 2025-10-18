import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { periodTask } from "../tasks/period"

export const periodsSchedule = schedules.task({
  id: "subscription.periods",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 12 hours in prod
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()
    const lookaheadMs = 3 * 24 * 60 * 60 * 1000 // act slightly ahead of term end of cycle 3 days

    // fetch all active subscriptions
    const subscriptions = await db.query.subscriptions.findMany({
      where: (subscription, ops) =>
        ops.and(
          ops.eq(subscription.active, true),
          ops.notInArray(subscription.status, ["canceled", "expired"]),
          ops.lte(subscription.currentCycleEndAt, now + lookaheadMs)
        ),
    })

    logger.info(`Found ${subscriptions.length} subscriptions for creating periods`)

    if (subscriptions.length === 0) {
      return {
        subscriptionIds: [],
      }
    }

    // triggers handle concurrency
    await periodTask.batchTrigger(
      subscriptions.map((s) => ({
        payload: {
          subscriptionId: s.id,
          projectId: s.projectId,
          now,
        },
      }))
    )

    return {
      subscriptionIds: subscriptions.map((p) => p.id),
    }
  },
})
