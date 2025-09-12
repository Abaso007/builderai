import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { billingTask } from "../tasks/billing"

export const billingSchedule = schedules.task({
  id: "invoice.billing",
  // if dev then every 5 minutes in dev mode
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: process.env.NODE_ENV === "development" ? "0 */2 * * *" : "0 */12 * * *",
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // find all subscriptions phases that are currently in trial and the trial ends at is in the past
    const pendingInvoices = await db.query.invoices
      .findMany({
        where: (table, { inArray, and, lte }) =>
          and(inArray(table.status, ["unpaid", "waiting"]), lte(table.dueAt, now)),
        limit: 100, // limit to 100 invoices to avoid overwhelming the system
        with: {
          subscriptionPhase: true,
          subscription: true,
        },
      })
      .then((invoices) => {
        return invoices.filter((inv) => inv.subscription.active)
      })

    // trigger handles concurrency
    await billingTask.batchTrigger(
      pendingInvoices.map((inv) => ({
        payload: {
          invoiceId: inv.id,
          subscriptionPhaseId: inv.subscriptionPhaseId,
          projectId: inv.projectId,
          subscriptionId: inv.subscriptionPhase.subscriptionId,
          now,
        },
      }))
    )

    logger.info(`Found ${pendingInvoices.length} pending invoices for billing`)

    return {
      invoiceIds: pendingInvoices.map((i) => i.id),
    }
  },
})
