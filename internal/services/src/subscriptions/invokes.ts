import { type Database, and, eq, inArray, lte, sql } from "@unprice/db"
import { billingPeriods, invoiceItems, invoices, subscriptions } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { calculateCycleWindow, calculateDateAt, calculateNextNCycles } from "@unprice/db/validators"
import type { Logger } from "@unprice/logging"
import { addDays, format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import type { CustomerService } from "../customers/service"
import type { SubscriptionContext } from "./types"
import { computeStatementKey } from "./utils"

export async function loadSubscription(payload: {
  context: SubscriptionContext
  logger: Logger
  db: Database
  customerService: CustomerService
}): Promise<SubscriptionContext> {
  const { context, logger, db, customerService } = payload
  const { subscriptionId, projectId, now } = context

  const result = await db.query.subscriptions.findFirst({
    with: {
      phases: {
        where: (phase, { lte, and, gte, isNull, or }) =>
          and(lte(phase.startAt, now), or(isNull(phase.endAt), gte(phase.endAt, now))),
        limit: 1, // we only need the active phase and there is only one at the time
        with: {
          planVersion: {
            with: {
              plan: true,
            },
          },
          customerEntitlements: {
            with: {
              featurePlanVersion: {
                with: {
                  feature: true,
                },
              },
            },
          },
          items: {
            with: {
              featurePlanVersion: {
                with: {
                  feature: true,
                },
              },
            },
          },
        },
      },
      customer: true,
    },
    where: (table, { eq, and }) =>
      and(eq(table.id, subscriptionId), eq(table.projectId, projectId)),
  })

  if (!result) {
    logger.error(`Subscription with ID ${subscriptionId} not found`)
    throw new Error(`Subscription with ID ${subscriptionId} not found`)
  }

  const { phases, customer, ...subscription } = result

  if (!customer) {
    logger.error(`Customer with ID ${result.customerId} not found`)
    throw new Error(`Customer with ID ${result.customerId} not found`)
  }

  // phase can be undefined if the subscription is paused or ended but still the machine can be in active state
  //  for instance the subscription was pasued there is no current phase but there is an option to resume and
  // subscribe to a new phase
  const currentPhase = phases[0]

  // check the payment method as well
  const { val, err: validatePaymentMethodErr } = await customerService.validatePaymentMethod({
    customerId: customer.id,
    projectId: projectId,
    paymentProvider: currentPhase?.planVersion.paymentProvider,
    requiredPaymentMethod: currentPhase?.planVersion.paymentMethodRequired,
  })

  if (validatePaymentMethodErr) {
    logger.error(`Error validating payment method: ${validatePaymentMethodErr.message}`)
    throw validatePaymentMethodErr
  }

  const { paymentMethodId, requiredPaymentMethod } = val

  let resultPhase = null

  if (currentPhase) {
    const { items, customerEntitlements, planVersion, ...phase } = currentPhase
    resultPhase = {
      ...phase,
      items: items ?? [],
      entitlements: customerEntitlements ?? [],
      planVersion: planVersion ?? null,
    }
  }

  // load due open invoices for this phase
  const hasOpenInvoices = await db.query.invoices.findFirst({
    where: (inv, { and, eq, inArray, lte }) =>
      and(
        eq(inv.projectId, subscription.projectId),
        eq(inv.subscriptionId, subscription.id),
        inArray(inv.status, ["draft"]),
        lte(inv.dueAt, now)
      ),
    orderBy: (inv, { asc }) => asc(inv.dueAt),
  })

  const hasDueBillingPeriods = await db.query.billingPeriods.findFirst({
    where: (bp, { and, eq, inArray, lte }) =>
      and(
        eq(bp.projectId, subscription.projectId),
        eq(bp.subscriptionId, subscription.id),
        inArray(bp.status, ["pending"]),
        lte(bp.invoiceAt, now)
      ),
    orderBy: (bp, { asc }) => asc(bp.invoiceAt),
  })

  return {
    now,
    subscriptionId: subscription.id,
    projectId: subscription.projectId,
    customer,
    currentPhase: resultPhase,
    subscription,
    paymentMethodId,
    requiredPaymentMethod,
    hasOpenInvoices: !!hasOpenInvoices,
    hasDueBillingPeriods: !!hasDueBillingPeriods,
  }
}

// renew only takes care of the subscription
// responsabilities:
// manage subscription/phase lifecycle at term boundaries.
// Apply scheduled plan changes, end trials, auto-renew or end phases, update subscriptions.currentCycleStartAt/EndAt.
// Orchestrate phase transitions and invariants, not charges.
// will pick up the current phase and appply the changes to the subscription
export async function renewSubscription(opts: {
  context: SubscriptionContext
  logger: Logger
  customerService: CustomerService
  db: Database
}) {
  const { context, logger, db } = opts
  const { subscription, currentPhase } = context

  if (!currentPhase) throw new Error("No active phase found")

  const current = calculateCycleWindow({
    now: context.now,
    trialEndsAt: currentPhase.trialEndsAt,
    effectiveEndDate: currentPhase.endAt ?? null,
    billingConfig: {
      ...currentPhase.planVersion.billingConfig,
      // always align the billing anchor to the phase anchor
      billingAnchor: currentPhase.billingAnchor,
    },
    effectiveStartDate: currentPhase.startAt,
  })

  if (!current) throw new Error("No current cycle window found")

  logger.debug(
    `Current billing window: ${new Date(current.start).toUTCString()} - ${new Date(current.end).toUTCString()}`
  )

  // next window (advance boundary for both modes)
  const next = calculateCycleWindow({
    now: current.end + 1,
    trialEndsAt: currentPhase.trialEndsAt,
    effectiveEndDate: currentPhase.endAt ?? null,
    billingConfig: {
      ...currentPhase.planVersion.billingConfig,
      // always align the billing anchor to the phase anchor
      billingAnchor: currentPhase.billingAnchor,
    },
    effectiveStartDate: currentPhase.startAt,
  })

  if (!next) throw new Error("No next cycle window found")

  logger.debug(
    `Next billing window: ${new Date(next.start).toUTCString()} - ${new Date(next.end).toUTCString()}`
  )

  // idempotent no-op if already at the correct window
  if (
    subscription.currentCycleStartAt === current.start &&
    subscription.currentCycleEndAt === current.end &&
    subscription.renewAt === next.start
  ) {
    return { subscription }
  }

  try {
    // TODO: fix this because none of this should happen here
    // // I have to reset entitlement usage
    // const { err: resetEntitlementsErr } = await customerService.syncActiveEntitlementsLastUsage({
    //   customerId: subscription.customerId,
    //   projectId: subscription.projectId,
    //   now: currentCycle.end,
    // })

    // if (resetEntitlementsErr) {
    //   throw resetEntitlementsErr
    // }

    // // invalidate entitlements data in unprice API and reset the entitlements usage
    // await unprice.customers.resetEntitlements({
    //   customerId: subscription.customerId,
    //   projectId: subscription.projectId,
    // })

    // // prewarm the entitlements cache and the DO
    // await unprice.customers.prewarmEntitlements({
    //   customerId: subscription.customerId,
    //   projectId: subscription.projectId,
    // })

    // update subscription for ui purposes
    const subscriptionUpdated = await db
      .update(subscriptions)
      .set({
        planSlug: currentPhase.planVersion.plan.slug, // consider slug
        renewAt: next.start, // schedule next boundary
        currentCycleStartAt: current.start,
        currentCycleEndAt: current.end,
      })
      .where(
        and(
          eq(subscriptions.id, subscription.id),
          eq(subscriptions.projectId, subscription.projectId)
        )
      )
      .returning()
      .then((result) => result[0])

    if (!subscriptionUpdated) {
      throw new Error("Subscription not updated")
    }

    return {
      subscription: subscriptionUpdated,
    }
  } catch (error) {
    logger.error(
      `Error while renewing subscription ${error instanceof Error ? error.message : "unknown error"}`,
      {
        error: JSON.stringify(error),
        subscriptionId: subscription.id,
      }
    )
    throw error
  }
}

// invoicing scheduler
// this will materialize all the pending invoices for the current phase or ended phases in the last N days
// the idea is to keep a record of every billing cycle for the subscription
// this way we can rely on these records to finalize and bill the invoices
export async function invoiceSubscription({
  context,
  logger,
  db,
}: {
  context: SubscriptionContext
  logger: Logger
  db: Database
}): Promise<
  Partial<SubscriptionContext> & {
    phasesProcessed: number
  }
> {
  const { subscription, now } = context

  // get pending periods items per subscription
  // can have multiple phases as long as they have the same statement key
  const periodItemsGroups = await db
    .select({
      projectId: billingPeriods.projectId,
      subscriptionId: billingPeriods.subscriptionId,
      subscriptionPhaseId: billingPeriods.subscriptionPhaseId,
      statementKey: billingPeriods.statementKey,
      invoiceAt: billingPeriods.invoiceAt,
    })
    .from(billingPeriods)
    .groupBy(
      billingPeriods.projectId,
      billingPeriods.subscriptionId,
      billingPeriods.subscriptionPhaseId,
      billingPeriods.statementKey,
      billingPeriods.invoiceAt
    )
    .where(
      and(
        eq(billingPeriods.status, "pending"),
        lte(billingPeriods.invoiceAt, now),
        eq(billingPeriods.projectId, subscription.projectId),
        eq(billingPeriods.subscriptionId, subscription.id)
      )
    )
    .limit(500) // limit to 500 period items to avoid overwhelming the system

  logger.info(`Invoicing for ${periodItemsGroups.length} periodItemsGroups`)

  // for each phase, materialize the invoice and items
  for (const periodItemGroup of periodItemsGroups) {
    // get the phase
    const phase = await db.query.subscriptionPhases.findFirst({
      with: {
        planVersion: true,
        subscription: true,
      },
      where: (table, { eq }) =>
        and(
          eq(table.projectId, periodItemGroup.projectId),
          eq(table.subscriptionId, periodItemGroup.subscriptionId),
          eq(table.id, periodItemGroup.subscriptionPhaseId)
        ),
    })

    if (!phase || !phase.planVersion || !phase.subscription) {
      logger.warn("Phase not found or missing plan version or subscription", {
        phaseId: periodItemGroup.subscriptionPhaseId,
        projectId: periodItemGroup.projectId,
        subscriptionId: periodItemGroup.subscriptionId,
      })
      continue
    }

    // get the billing periods to invoice every item in the phase
    const billingPeriodsToInvoice = await db.query.billingPeriods.findMany({
      with: {
        subscriptionItem: {
          with: {
            featurePlanVersion: true,
          },
        },
      },
      where: (table, { eq }) =>
        and(
          eq(table.projectId, periodItemGroup.projectId),
          eq(table.subscriptionId, periodItemGroup.subscriptionId),
          eq(table.subscriptionPhaseId, periodItemGroup.subscriptionPhaseId),
          eq(table.statementKey, periodItemGroup.statementKey)
        ),
    })

    // if no billing periods to invoice, skip
    if (!billingPeriodsToInvoice) {
      logger.warn("Billing period to invoice not found", {
        phaseId: periodItemGroup.subscriptionPhaseId,
        projectId: periodItemGroup.projectId,
        subscriptionId: periodItemGroup.subscriptionId,
      })
      continue
    }

    // statement start and end at is min and max of the billing periods
    const statementStartAt = Math.min(...billingPeriodsToInvoice.map((bp) => bp.cycleStartAt))
    const statementEndAt = Math.max(...billingPeriodsToInvoice.map((bp) => bp.cycleEndAt))

    // all of this happens in a single transaction
    await db.transaction(async (tx) => {
      try {
        const invoiceAt = periodItemGroup.invoiceAt
        // wait so we can aovid late usage records being flushed from analytics system
        const waitPeriodAdvance = 1000 * 60 * 15 // 15 minutes
        const waitPeriodArrear = 1000 * 60 * 60 // 1 hour

        // statement date string is the date that is shown on the invoice
        // take the timezone from the subscription
        const timezone = phase.subscription.timezone
        const date = toZonedTime(new Date(invoiceAt), timezone)
        const statementDateString = format(date, "MMMM d, yyyy")

        // pay in advance have smaller grace period
        const dueAt =
          phase.planVersion.whenToBill === "pay_in_advance"
            ? invoiceAt + waitPeriodAdvance
            : invoiceAt + waitPeriodArrear

        // grace period depening on the interval
        // this handles failed payments or other issues
        const pastDueAt = calculateDateAt({
          startDate: dueAt,
          config: {
            interval: phase.planVersion.billingConfig.billingInterval,
            units: phase.planVersion.gracePeriod,
          },
        })

        // create invoice
        let invoice = await tx
          .insert(invoices)
          .values({
            id: newId("invoice"),
            projectId: phase.projectId,
            subscriptionId: phase.subscriptionId,
            customerId: phase.subscription.customerId,
            requiredPaymentMethod: phase.planVersion.paymentMethodRequired,
            paymentMethodId: phase.paymentMethodId ?? null,
            status: "draft",
            statementDateString: statementDateString,
            statementKey: periodItemGroup.statementKey,
            statementStartAt: statementStartAt,
            statementEndAt: statementEndAt,
            whenToBill: phase.planVersion.whenToBill,
            collectionMethod: phase.planVersion.collectionMethod,
            invoicePaymentProviderId: "",
            invoicePaymentProviderUrl: "",
            paymentProvider: phase.planVersion.paymentProvider,
            currency: phase.planVersion.currency,
            pastDueAt: pastDueAt,
            dueAt: dueAt,
            // all this is calculated in finalizeInvoice
            paidAt: null,
            subtotal: 0,
            paymentAttempts: [],
            total: 0,
            amountCreditUsed: 0,
            issueDate: null, // we don't have a issue date yet
            metadata: { note: "Invoiced by scheduler" },
          }) // idempotency protection
          .onConflictDoNothing({
            target: [
              invoices.projectId,
              invoices.subscriptionId,
              invoices.customerId,
              invoices.statementKey,
            ],
          })
          .returning()
          .catch((error) => {
            logger.error("Error while creating invoice", {
              phaseId: phase.id,
              statementStartAt: statementStartAt,
              statementEndAt: statementEndAt,
              error: error instanceof Error ? error.message : "unknown error",
            })
            throw error
          })
          .then((result) => result[0])

        // if invoice is not created, try to retrieve it
        if (!invoice) {
          invoice = await tx.query.invoices.findFirst({
            where: (inv, { eq, and }) =>
              and(
                eq(inv.statementKey, periodItemGroup.statementKey),
                eq(inv.projectId, phase.projectId),
                eq(inv.subscriptionId, phase.subscriptionId),
                eq(inv.customerId, phase.subscription.customerId)
              ),
          })
        }

        if (!invoice) {
          logger.error("Invoice not created", {
            phaseId: phase.id,
            statementStartAt: statementStartAt,
            statementEndAt: statementEndAt,
          })

          return
        }

        const invoiceItemsData = billingPeriodsToInvoice.map((period) => ({
          id: newId("invoice_item"),
          invoiceId: invoice.id,
          featurePlanVersionId: period.subscriptionItem.featurePlanVersion.id,
          subscriptionItemId: period.subscriptionItem.id,
          billingPeriodId: period.id,
          projectId: period.projectId,
          quantity: period.subscriptionItem.units ?? 0,
          cycleStartAt: period.cycleStartAt,
          cycleEndAt: period.cycleEndAt,
          kind: period.type === "trial" ? ("trial" as const) : ("period" as const),
          unitAmountCents: 0,
          amountSubtotal: 0,
          amountTotal: 0,
          prorationFactor: period.prorationFactor,
          description: period.type === "trial" ? "Trial" : "Billing period",
          itemProviderId: null,
        }))

        // create invoice items
        await tx
          .insert(invoiceItems)
          .values(invoiceItemsData)
          // idempotency protection
          .onConflictDoNothing({
            target: [invoiceItems.projectId, invoiceItems.invoiceId, invoiceItems.billingPeriodId],
            where: sql`${invoiceItems.billingPeriodId} IS NOT NULL`,
          })
          .catch((error) => {
            logger.error("Error while creating invoice items", {
              phaseId: phase.id,
              statementStartAt: statementStartAt,
              statementEndAt: statementEndAt,
              error: error instanceof Error ? error.message : "unknown error",
            })
            throw error
          })

        // get the invoice items that were inserted
        const invoiceItemsInserted = await tx.query.invoiceItems.findMany({
          columns: {
            billingPeriodId: true,
          },
          where: (item, { eq, and }) =>
            and(eq(item.invoiceId, invoice.id), eq(item.projectId, phase.projectId)),
        })

        // update billing period to invoiced
        await tx
          .update(billingPeriods)
          .set({
            status: "invoiced",
            invoiceId: invoice.id,
          })
          .where(
            and(
              inArray(
                billingPeriods.id,
                invoiceItemsInserted
                  .map((period) => period.billingPeriodId)
                  .filter((id) => id !== null)
              ),
              eq(billingPeriods.projectId, phase.projectId),
              eq(billingPeriods.subscriptionId, phase.subscriptionId)
            )
          )
      } catch (error) {
        logger.error("Error while invoicing phase", {
          phaseId: phase.id,
          statementStartAt: statementStartAt,
          statementEndAt: statementEndAt,
          error: error instanceof Error ? error.message : "unknown error",
        })

        tx.rollback()
        throw error
      }
    })
  }

  // get the last open invoices to update the openInvoices
  const lastOpenInvoices = await db.query.invoices.findFirst({
    where: (inv, { and, eq, inArray, lte }) =>
      and(
        eq(inv.projectId, subscription.projectId),
        eq(inv.subscriptionId, subscription.id),
        inArray(inv.status, ["draft", "unpaid", "waiting"]),
        lte(inv.dueAt, now)
      ),
    orderBy: (inv, { asc }) => asc(inv.dueAt),
  })

  // get the last open billing periods to update the hasDueBillingPeriods
  const lastDueBillingPeriods = await db.query.billingPeriods.findFirst({
    where: (bp, { and, eq, inArray, lte }) =>
      and(
        eq(bp.projectId, subscription.projectId),
        eq(bp.subscriptionId, subscription.id),
        inArray(bp.status, ["pending"]),
        lte(bp.cycleEndAt, now)
      ),
    orderBy: (bp, { asc }) => asc(bp.cycleEndAt),
  })

  return {
    phasesProcessed: periodItemsGroups.length,
    subscription,
    hasOpenInvoices: !!lastOpenInvoices,
    hasDueBillingPeriods: !!lastDueBillingPeriods,
  }
}

// / TODO: delete this from here and pass to utils (shouldn't be a machine invoke)
// generating billing periods
// this will materialize all the pending billing periods for the current phase or ended phases in the last N days
// the idea is to keep a record of every billing cycle for the subscription
// this way we can rely on these records to finalize and bill the invoices
export async function generateBillingPeriods({
  context,
  logger,
  db,
}: {
  context: SubscriptionContext
  logger: Logger
  db: Database
}): Promise<
  Partial<SubscriptionContext> & {
    phasesProcessed: number
  }
> {
  const { subscription, now } = context
  const lookbackDays = 7 // lookback days to materialize the periods
  const batch = 100 // process a max of 100 phases per trigger run

  // fetch phases that are active now OR ended recently
  const phases = await db.query.subscriptionPhases.findMany({
    with: {
      planVersion: true,
      subscription: true,
      items: {
        with: {
          featurePlanVersion: true,
        },
      },
    },
    where: (phase, ops) =>
      ops.and(
        ops.eq(phase.projectId, subscription.projectId),
        ops.eq(phase.subscriptionId, subscription.id),
        ops.lte(phase.startAt, now),
        ops.or(ops.isNull(phase.endAt), ops.gte(phase.endAt, addDays(now, -lookbackDays).getTime()))
      ),
    limit: batch, // limit to batch size to avoid overwhelming the system
  })

  logger.info(`Materializing billing periods for ${phases.length} phases`)

  let cyclesCreated = 0

  // for each phase, materialize the periods
  for (const phase of phases) {
    // For every subscription item, backfill missing billing periods idempotently
    for (const item of phase.items) {
      // Find the last period for this item to make per-item backfill
      const lastForItem = await db.query.billingPeriods.findFirst({
        where: (bp, ops) =>
          ops.and(
            ops.eq(bp.projectId, phase.projectId),
            ops.eq(bp.subscriptionId, phase.subscriptionId),
            ops.eq(bp.subscriptionPhaseId, phase.id),
            ops.eq(bp.subscriptionItemId, item.id)
          ),
        orderBy: (bp, ops) => ops.desc(bp.cycleEndAt),
      })

      const cursorStart = lastForItem ? lastForItem.cycleEndAt : phase.startAt
      // INFO: this is a compatibility fix for the old data
      const itemBillingConfig = item.featurePlanVersion.billingConfig?.billingInterval
        ? item.featurePlanVersion.billingConfig
        : phase.planVersion.billingConfig

      const windows = calculateNextNCycles({
        referenceDate: now, // we use the now to start the calculation
        effectiveStartDate: cursorStart,
        trialEndsAt: phase.trialEndsAt,
        effectiveEndDate: phase.endAt,
        billingConfig: {
          ...itemBillingConfig,
          // always align the billing anchor to the phase anchor
          billingAnchor: phase.billingAnchor,
        },
        count: 0, // we only need until the end of the current cycle
      })

      if (windows.length === 0) continue

      // Insert periods idempotently with unique index protection
      const values = await Promise.all(
        windows.map(async (w) => {
          const whenToBill = phase.planVersion.whenToBill
          // handles when to invoice this way pay in advance aligns with the cycle start
          // and pay in arrear aligns with the cycle end
          const invoiceAt = whenToBill === "pay_in_advance" ? w.start : w.end
          const statementKey = await computeStatementKey({
            projectId: phase.projectId,
            customerId: phase.subscription.customerId,
            subscriptionId: phase.subscriptionId,
            invoiceAt: invoiceAt,
            currency: phase.planVersion.currency,
            paymentProvider: phase.planVersion.paymentProvider,
            collectionMethod: phase.planVersion.collectionMethod,
          })

          return {
            id: newId("billing_period"),
            projectId: phase.projectId,
            subscriptionId: phase.subscriptionId,
            subscriptionPhaseId: phase.id,
            subscriptionItemId: item.id,
            status: "pending" as const,
            type: w.isTrial ? ("trial" as const) : ("normal" as const),
            cycleStartAt: w.start,
            cycleEndAt: w.end,
            statementKey: statementKey,
            // if trial, we invoice at the end always
            invoiceAt: w.isTrial ? w.end : invoiceAt,
            whenToBill: whenToBill,
            invoiceId: null,
            amountEstimateCents: null,
            prorationFactor: w.prorationFactor,
            reason: w.isTrial ? ("trial" as const) : ("normal" as const),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
        })
      )

      cyclesCreated += values.length

      try {
        await db
          .insert(billingPeriods)
          .values(values)
          .onConflictDoNothing({
            target: [
              billingPeriods.projectId,
              billingPeriods.subscriptionId,
              billingPeriods.subscriptionPhaseId,
              billingPeriods.subscriptionItemId,
              billingPeriods.cycleStartAt,
              billingPeriods.cycleEndAt,
            ],
          })
      } catch (e) {
        logger.warn("Skipping existing billing periods (likely conflict)", {
          phaseId: phase.id,
          subscriptionId: phase.subscriptionId,
          projectId: phase.projectId,
          error: (e as Error)?.message,
        })
      }
    }
  }

  logger.info(`Created ${cyclesCreated} billing periods for ${phases.length} phases`)

  // get the last open billing periods to update the hasDueBillingPeriods
  const lastDueBillingPeriods = await db.query.billingPeriods.findFirst({
    where: (bp, { and, eq, inArray, lte }) =>
      and(
        eq(bp.projectId, subscription.projectId),
        eq(bp.subscriptionId, subscription.id),
        inArray(bp.status, ["pending"]),
        lte(bp.cycleEndAt, now)
      ),
    orderBy: (bp, { asc }) => asc(bp.cycleEndAt),
  })

  const updatedCurrentPhase = phases.find(
    (p) => p.startAt <= now && (p.endAt === null || p.endAt >= now)
  )

  return {
    phasesProcessed: phases.length,
    hasDueBillingPeriods: !!lastDueBillingPeriods,
    subscription: updatedCurrentPhase?.subscription,
  }
}
