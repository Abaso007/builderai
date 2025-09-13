import { logger, schedules } from "@trigger.dev/sdk/v3"
import { and, eq, lte } from "@unprice/db"
import { billingPeriods } from "@unprice/db/schema"
import { db } from "../db"
import { invoiceTask } from "../tasks/invoice"

export const invoicingSchedule = schedules.task({
  id: "invoice.invoicing",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 1 hour in prod
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // get pending periods items per phase
    const periodItems = await db
      .select({
        projectId: billingPeriods.projectId,
        subscriptionId: billingPeriods.subscriptionId,
        subscriptionPhaseId: billingPeriods.subscriptionPhaseId,
        cycleStartAt: billingPeriods.cycleStartAt,
        cycleEndAt: billingPeriods.cycleEndAt,
      })
      .from(billingPeriods)
      .groupBy(
        billingPeriods.projectId,
        billingPeriods.subscriptionId,
        billingPeriods.subscriptionPhaseId,
        billingPeriods.cycleStartAt,
        billingPeriods.cycleEndAt
      )
      .where(and(eq(billingPeriods.status, "pending"), lte(billingPeriods.cycleEndAt, now)))
      .limit(500) // limit to 500 period items to avoid overwhelming the system

    const periodItemsWithActiveSubscription = periodItems.filter((s) => s.subscriptionId !== null)

    logger.info(`Found ${periodItemsWithActiveSubscription.length} period items for invoicing`)

    if (periodItemsWithActiveSubscription.length === 0) {
      return {
        subscriptionIds: [],
      }
    }

    // trigger handles concurrency
    await invoiceTask.batchTrigger(
      periodItemsWithActiveSubscription.map((sub) => ({
        payload: {
          subscriptionId: sub.subscriptionId,
          projectId: sub.projectId,
          now,
        },
      }))
    )

    return {
      subscriptionIds: periodItems.map((s) => s.subscriptionId),
    }
  },
})
