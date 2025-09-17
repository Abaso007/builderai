import { logger, schedules } from "@trigger.dev/sdk/v3"
import { and, eq, lte } from "@unprice/db"
import { invoices } from "@unprice/db/schema"

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

    // find all subscription that have invoices in draft status and are due
    const subscriptions = await db
      .select({
        projectId: invoices.projectId,
        subscriptionId: invoices.subscriptionId,
      })
      .from(invoices)
      .where(and(eq(invoices.status, "draft"), lte(invoices.dueAt, now)))
      .groupBy(invoices.projectId, invoices.subscriptionId)

    logger.info(`Found ${subscriptions.length} subscriptions for finilizing`)

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
          subscriptionId: s.subscriptionId,
          now,
        },
      }))
    )

    return {
      subscriptionIds: subscriptions.map((s) => s.subscriptionId),
    }
  },
})
