import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "@unprice/db"
import { renewTask } from "../tasks"

export const renewSchedule = schedules.task({
  id: "subscriptionPhase.renew",
  // every 12 hours (UTC timezone)
  cron: "0 */12 * * *",
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    const subscriptions = await db.query.subscriptions.findMany({
      with: {
        phases: {
          where: (phase, { eq, and, inArray }) =>
            and(
              eq(phase.active, true),
              inArray(phase.status, ["active", "trial_ended"]),
              eq(phase.autoRenew, true)
            ),
          orderBy: (phase, { asc }) => [asc(phase.startAt)],
        },
      },
      where: (sub, { eq, and, lte, isNull }) =>
        and(
          eq(sub.active, true),
          lte(sub.renewAt, now),
          // next invoice at should be after the renew at
          // so we are sure the subscription has been invoiced
          lte(sub.renewAt, sub.nextInvoiceAt),
          // we should not renew if there is a change, cancel or expire scheduled
          isNull(sub.changeAt),
          isNull(sub.cancelAt),
          isNull(sub.expiresAt)
        ),
    })

    logger.info(`Found ${subscriptions.length} subscriptions for renewing`)

    // trigger the end trial task for each subscription phase
    for (const sub of subscriptions) {
      // get the first active phase
      const phase = sub.phases[0]

      if (!phase) {
        logger.error(`No active phase found for subscription ${sub.id}`)
        continue
      }

      await renewTask.triggerAndWait({
        subscriptionId: sub.id,
        projectId: sub.projectId,
        now: sub.nextInvoiceAt + 1,
        phaseId: phase.id,
      })
    }

    return {
      subscriptionIds: subscriptions.map((s) => s.id),
    }
  },
})
