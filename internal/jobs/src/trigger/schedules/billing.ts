import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { billingTask } from "../tasks/billing"
import { finilizeTask } from "../tasks/finilize"

export const billingSchedule = schedules.task({
  id: "subscriptionPhase.billing",
  // if dev then every 5 minutes in dev mode
  cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // find all subscriptions phases that are currently in trial and the trial ends at is in the past
    const pendingInvoices = await db.query.invoices.findMany({
      where: (table, { inArray, and, lte }) =>
        and(inArray(table.status, ["draft", "unpaid", "waiting"]), lte(table.dueAt, now)),
      limit: 100, // limit to 100 invoices to avoid overwhelming the system
      with: {
        subscriptionPhase: true,
        customer: true,
      },
    })

    // if the customer is not active, we skip the invoice
    // this is useful to avoid billing invoices for customers that are not active
    const pendingInvoicesWithActiveCustomer = pendingInvoices.filter((inv) => inv.customer.active)

    // Process invoices in bounded batches using Trigger.dev batch APIs.
    // Preserve per-invoice ordering (finalize -> bill) by batching finalize first,
    // then billing only those that either didn't need finalize or finalized successfully.
    const concurrency = 10
    for (let i = 0; i < pendingInvoicesWithActiveCustomer.length; i += concurrency) {
      const batch = pendingInvoicesWithActiveCustomer.slice(i, i + concurrency)

      const toFinalize = batch.filter((inv) => inv.status === "draft")

      let finalizedOkIds = new Set<string>()

      if (toFinalize.length > 0) {
        try {
          const finalizeResults = await finilizeTask.batchTriggerAndWait(
            toFinalize.map((invoice) => ({
              payload: {
                subscriptionPhaseId: invoice.subscriptionPhaseId,
                invoiceId: invoice.id,
                projectId: invoice.projectId,
                subscriptionId: invoice.subscriptionPhase.subscriptionId,
                now,
              },
            }))
          )

          // Correlate finalize results with inputs by index and collect successes
          const runs = finalizeResults.runs
          const length = Math.min(toFinalize.length, runs.length)

          for (let idx = 0; idx < length; idx++) {
            const run = runs[idx]
            const inv = toFinalize[idx]
            if (run?.ok) {
              if (inv) finalizedOkIds.add(inv.id)
            } else if (run && inv) {
              logger.error("Finalize run failed", {
                invoiceId: inv.id,
                error: run.error,
              })
            }
          }
        } catch (err) {
          logger.error("Failed to batch finalize invoices", {
            error: err instanceof Error ? err.message : "Unknown error",
            invoiceIds: toFinalize.map((i) => i.id),
          })
          // On batch error, skip billing for drafts; still bill non-drafts below
          finalizedOkIds = new Set<string>()
        }
      }

      const toBill = batch.filter((inv) => inv.status !== "draft" || finalizedOkIds.has(inv.id))

      if (toBill.length > 0) {
        await billingTask.batchTriggerAndWait(
          toBill.map((invoice) => ({
            payload: {
              subscriptionPhaseId: invoice.subscriptionPhaseId,
              invoiceId: invoice.id,
              projectId: invoice.projectId,
              subscriptionId: invoice.subscriptionPhase.subscriptionId,
              now,
            },
          }))
        )
      }
    }

    logger.info(`Found ${pendingInvoicesWithActiveCustomer.length} pending invoices`)

    return {
      invoiceIds: pendingInvoicesWithActiveCustomer.map((i) => i.id),
    }
  },
})
