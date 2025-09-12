import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { periodTask } from "../tasks"

export const periodsSchedule = schedules.task({
  id: "subscription.phase.periods",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 12 hours in prod
  cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  run: async (payload) => {
    const now = payload.timestamp.getTime()
    const lookbackDays = 7 // lookback days to create the periods
    const lookbackDaysMs = lookbackDays * 24 * 60 * 60 * 1000

    // fetch phases that are active now OR ended recently
    const phasesWithActiveSubscription = await db.query.subscriptionPhases
      .findMany({
        with: {
          subscription: true,
        },
        where: (phase, ops) =>
          ops.and(
            ops.lte(phase.startAt, now),
            ops.or(ops.isNull(phase.endAt), ops.gte(phase.endAt, now - lookbackDaysMs))
          ),
        limit: 100, // limit to batch size to avoid overwhelming the system
      })
      .then((phases) => {
        return phases.filter((p) => p.subscription.active)
      })

    logger.info(
      `Found ${phasesWithActiveSubscription.length} phases for creating periods with active subscription`
    )

    // trigger handles concurrency
    await periodTask.batchTrigger(
      phasesWithActiveSubscription.map((p) => ({
        payload: {
          phaseId: p.id,
          projectId: p.projectId,
          now,
          subscriptionId: p.subscriptionId,
        },
      }))
    )

    return {
      phaseIds: phasesWithActiveSubscription.map((p) => p.id),
    }
  },
})
