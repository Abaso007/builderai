import { logger, schedules } from "@trigger.dev/sdk/v3"
import { and, eq, gte, sql } from "@unprice/db"
import { billingPeriods } from "@unprice/db/schema"
import { db } from "../db"
import { invoiceTask } from "../tasks/invoice"

export const invoicingSchedule = schedules.task({
  id: "subscriptionPhase.invoicing",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 1 hour in prod
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: process.env.NODE_ENV === "development" ? "0 */2 * * *" : "0 */12 * * *",
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // get pending periods items per phase
    const periodItems = await db
      .select({
        projectId: billingPeriods.projectId,
        subscriptionId: billingPeriods.subscriptionId,
        subscriptionPhaseId: billingPeriods.subscriptionPhaseId,
        cycleStartAt: sql<number>`min(${billingPeriods.cycleStartAt})`,
        cycleEndAt: sql<number>`max(${billingPeriods.cycleEndAt})`,
        count: sql<number>`count(*)`,
      })
      .from(billingPeriods)
      .groupBy(
        billingPeriods.projectId,
        billingPeriods.subscriptionId,
        billingPeriods.subscriptionPhaseId
      )
      .where(and(eq(billingPeriods.status, "pending"), gte(billingPeriods.cycleEndAt, now)))
      .limit(100)

    const periodItemsWithActiveSubscription = periodItems.filter((s) => s.count > 0)

    logger.info(`Found ${periodItemsWithActiveSubscription.length} period items for invoicing`)

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
