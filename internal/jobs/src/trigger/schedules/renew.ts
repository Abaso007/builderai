import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { renewTask } from "../tasks"

export const renewSchedule = schedules.task({
  id: "subscriptionPhase.renew",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 1 hour in prod
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: process.env.NODE_ENV === "development" ? "0 */2 * * *" : "0 */12 * * *",
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // renew only takes care of the subscription
    // responsabilities:
    // manage subscription/phase lifecycle at term boundaries.
    // Apply scheduled plan changes, end trials, auto-renew or end phases, update subscriptions.currentCycleStartAt/EndAt.
    // Orchestrate phase transitions and invariants, not charges.
    const lookaheadMs = 1 * 60 * 60 * 1000 // act slightly ahead of term renew in hours
    const windowEnd = now + lookaheadMs

    // 1) Find phases that need lifecycle work
    const phasesActiveSubscription = await db.query.subscriptionPhases
      .findMany({
        with: {
          subscription: true,
        },
        where: (p, ops) =>
          ops.and(
            // phase is ongoing or ends soon/recently
            ops.lte(p.renewAt, windowEnd)
          ),
        limit: 200,
      })
      .then((phases) => {
        return phases.filter((p) => p.subscription.active)
      })

    logger.info(`Found ${phasesActiveSubscription.length} phases for renewing`)

    // create a new invoice for the period items

    // trigger handles concurrency
    await renewTask.batchTrigger(
      phasesActiveSubscription.map((s) => ({
        payload: {
          subscriptionId: s.subscription.id,
          phaseId: s.id,
          projectId: s.subscription.projectId,
          now,
        },
      }))
    )

    return {
      phaseIds: phasesActiveSubscription.map((p) => p.id),
    }
  },
})
