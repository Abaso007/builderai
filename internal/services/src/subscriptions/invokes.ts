import { eq } from "@unprice/db"
import { billingPeriods, invoices, subscriptionPhases, subscriptions } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { enumerateBillingWindows, getCurrentBillingWindow } from "@unprice/db/validators"
import type { Logger } from "@unprice/logging"
import { addDays, addMinutes } from "date-fns"
import type { CustomerService } from "../customers/service"
import { db } from "../utils/db"
import type { SubscriptionContext } from "./types"
import { validatePaymentMethod } from "./utils"

export async function loadSubscription(payload: {
  context: SubscriptionContext
  logger: Logger
}): Promise<SubscriptionContext> {
  const { context, logger } = payload
  const { subscriptionId, projectId, now } = context

  const result = await db.query.subscriptions.findFirst({
    with: {
      phases: {
        where: (phase, { lte, and, gte, isNull, or }) =>
          and(lte(phase.startAt, now), or(isNull(phase.endAt), gte(phase.endAt, now))),
        limit: 1, // we only need the active phase and there is only one at the time
        with: {
          planVersion: true,
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
    throw new Error(`Subscription with ID ${subscriptionId} not found`)
  }

  const { phases, customer, ...subscription } = result

  if (!customer) {
    throw new Error(`Customer with ID ${result.customerId} not found`)
  }

  // phase can be undefined if the subscription is paused or ended but still the machine can be in active state
  //  for instance the subscription was pasued there is no current phase but there is an option to resume and
  // subscribe to a new phase
  const currentPhase = phases[0]

  // check the payment method as well
  const { paymentMethodId, requiredPaymentMethod } = await validatePaymentMethod({
    customer,
    paymentProvider: currentPhase?.planVersion.paymentProvider,
    requiredPaymentMethod: currentPhase?.planVersion.paymentMethodRequired,
    logger: logger,
  })

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
        inArray(inv.status, ["draft", "unpaid", "waiting"]),
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
        lte(bp.cycleEndAt, now)
      ),
    orderBy: (bp, { asc }) => asc(bp.cycleEndAt),
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

export async function renewSubscription(opts: {
  context: SubscriptionContext
  logger: Logger
  customerService: CustomerService
}) {
  const { context, logger } = opts
  const { subscription, currentPhase } = context

  if (!currentPhase) throw new Error("No active phase found")

  const currentCycle = getCurrentBillingWindow({
    now: context.now,
    trialEndsAt: currentPhase.trialEndsAt,
    endAt: currentPhase.endAt,
    anchor: currentPhase.billingAnchor,
    interval: currentPhase.planVersion.billingConfig.billingInterval,
    intervalCount: currentPhase.planVersion.billingConfig.billingIntervalCount,
  })

  const renewAt =
    currentPhase.planVersion.whenToBill === "pay_in_advance" ? currentCycle.start : currentCycle.end

  // idempotent: if already at the next window, nothing to do
  if (
    currentPhase.currentCycleStartAt === currentCycle.start &&
    currentPhase.currentCycleEndAt === currentCycle.end &&
    currentPhase.renewAt === renewAt
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
        planSlug: currentPhase.planVersion.title,
        currentCycleStartAt: currentCycle.start,
        currentCycleEndAt: currentCycle.end,
      })
      .where(eq(subscriptions.id, subscription.id))
      .returning()
      .then((result) => result[0])

    // update subscription phase cycle
    const phaseUpdated = await db
      .update(subscriptionPhases)
      .set({
        renewAt: renewAt,
        currentCycleStartAt: currentCycle.start,
        currentCycleEndAt: currentCycle.end,
      })
      .where(eq(subscriptionPhases.id, currentPhase.id))
      .returning()
      .then((result) => result[0])

    if (!subscriptionUpdated) {
      throw new Error("Subscription not found, or not updated")
    }

    return {
      subscription: subscriptionUpdated,
      currentPhase: phaseUpdated,
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
}: {
  context: SubscriptionContext
  logger: Logger
}): Promise<
  Partial<SubscriptionContext> & {
    phasesProcessed: number
  }
> {
  const { subscription, now } = context
  const lookbackDays = 120 // lookback days to materialize the periods
  const horizonCycles = 1 // materialize up to next 1 cycle in the future
  const batch = 50 // process a max of 50 phases

  // fetch phases that are active now OR ended recently
  const phases = await db.query.subscriptionPhases.findMany({
    with: {
      planVersion: true,
      subscription: true,
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

  logger.info(`Materializing periods for ${phases.length} phases`)

  // for each phase, materialize the periods
  for (const phase of phases) {
    // last known invoice for this phase
    // doesn't matter if the invoice is draft, unpaid, waiting, etc.
    // we just need to know the last invoice cycle end at to know
    // if we need to backfill the periods
    const last = await db.query.invoices.findFirst({
      where: (inv, ops) =>
        ops.and(
          ops.eq(inv.subscriptionPhaseId, phase.id),
          ops.eq(inv.projectId, phase.projectId),
          ops.eq(inv.subscriptionId, phase.subscriptionId)
        ),
      orderBy: (inv, ops) => ops.desc(inv.cycleEndAt),
    })

    // start from the last invoice cycle end at or
    // the phase start at if there is no last invoice
    let cursorStart = last ? last.cycleEndAt + 1 : phase.startAt

    // compute a small future horizon (at most 1 cycle ahead)
    let cyclesCreated = 0

    while (true) {
      // configure the billing cycle window
      const bc = getCurrentBillingWindow({
        now: cursorStart,
        trialEndsAt: phase.trialEndsAt,
        endAt: phase.endAt,
        anchor: phase.billingAnchor,
        interval: phase.planVersion.billingConfig.billingInterval,
        intervalCount: phase.planVersion.billingConfig.billingIntervalCount,
      })

      const cycleStart = bc.start
      const cycleEnd = bc.end

      // stop if beyond end or we created enough future cycles
      if (phase.endAt && cycleStart > phase.endAt) break
      if (cycleStart > now && cyclesCreated >= horizonCycles) break

      // calculate the due at
      const dueAt = phase.planVersion.whenToBill === "pay_in_advance" ? cycleStart : cycleEnd

      // Determines if this is the first invoice after a trial period for a subscription that bills in advance
      // This is true when:
      // 1. The subscription bills in advance
      // 2. There was a trial period (trialEndsAt exists)
      // 3. This cycle starts after the trial ended
      // 4. Either there's no previous invoice, or the last invoice ended before trial ended
      const isFirstPostTrialAdvance =
        phase.planVersion.whenToBill === "pay_in_advance" &&
        phase.trialEndsAt != null &&
        cycleStart >= phase.trialEndsAt &&
        (!last || last.cycleEndAt < phase.trialEndsAt)

      // if so we only charge the flat charges cuz the usage during the trial period is not charged
      const invoiceType = isFirstPostTrialAdvance ? "flat" : "hybrid"

      // calculate the grace period
      const graceFn =
        phase.planVersion.billingConfig.billingInterval === "minute" ? addMinutes : addDays
      // this is when the invoice will be considered past due after that if not paid we can end it, cancel it, etc.
      const pastDueAt = graceFn(dueAt, phase.planVersion.gracePeriod).getTime()

      try {
        await db
          .insert(invoices)
          .values({
            id: newId("invoice"),
            projectId: phase.projectId,
            subscriptionId: phase.subscriptionId,
            subscriptionPhaseId: phase.id,
            customerId: phase.subscription.customerId,
            requiredPaymentMethod: phase.planVersion.paymentMethodRequired,
            paymentMethodId: phase.paymentMethodId ?? null,
            status: "draft",
            type: invoiceType,
            cycleStartAt: cycleStart,
            cycleEndAt: cycleEnd,
            issueDate: last?.issueDate ?? null,
            whenToBill: phase.planVersion.whenToBill,
            dueAt,
            paidAt: null,
            subtotal: 0,
            total: 0,
            amountCreditUsed: 0,
            collectionMethod: phase.planVersion.collectionMethod,
            invoicePaymentProviderId: "",
            invoicePaymentProviderUrl: "",
            paymentProvider: phase.planVersion.paymentProvider,
            currency: phase.planVersion.currency,
            pastDueAt,
            metadata: { note: "Materialized by scheduler" },
          })
          .onConflictDoNothing({
            target: [
              invoices.projectId,
              invoices.subscriptionId,
              invoices.subscriptionPhaseId,
              invoices.customerId,
              invoices.cycleStartAt,
              invoices.cycleEndAt,
            ],
          })
      } catch (e) {
        // ignore unique violations; the unique index prevents duplicates
        logger.warn("Insert invoice skipped (likely exists)", {
          phaseId: phase.id,
          cycleStart,
          cycleEnd,
          error: (e as Error)?.message,
        })
      }

      cursorStart = cycleEnd + 1
      cyclesCreated += cycleStart > now ? 1 : 0

      // break if we reached now and the phase ended in the past
      if ((!phase.endAt || phase.endAt <= now) && cycleEnd > now) break
    }
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

  return {
    phasesProcessed: phases.length,
    subscription,
    hasOpenInvoices: !!lastOpenInvoices,
  }
}

// generating billing periods
// this will materialize all the pending billing periods for the current phase or ended phases in the last N days
// the idea is to keep a record of every billing cycle for the subscription
// this way we can rely on these records to finalize and bill the invoices
export async function generateBillingPeriods({
  context,
  logger,
}: {
  context: SubscriptionContext
  logger: Logger
}): Promise<
  Partial<SubscriptionContext> & {
    phasesProcessed: number
  }
> {
  const { subscription, now } = context
  const lookbackDays = 7 // lookback days to materialize the periods
  const batch = 100 // process a max of 100 phases per trigger run

  if (!subscription.active) {
    return {
      phasesProcessed: 0,
      subscription,
    }
  }

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

      const cursorStart = lastForItem ? lastForItem.cycleEndAt + 1 : phase.startAt
      // INFO: this is a compatibility fix for the old data
      const itemBillingConfig = item.featurePlanVersion.billingConfig?.billingInterval
        ? item.featurePlanVersion.billingConfig
        : phase.planVersion.billingConfig

      const windows = enumerateBillingWindows({
        startAt: cursorStart,
        now,
        trialEndsAt: phase.trialEndsAt ?? null,
        endAt: phase.endAt ?? null,
        anchor: phase.billingAnchor,
        interval: itemBillingConfig.billingInterval,
        intervalCount: itemBillingConfig.billingIntervalCount,
      })

      if (windows.length === 0) continue

      // Insert periods idempotently with unique index protection
      const values = windows.map((w) => ({
        id: newId("billing_period"),
        projectId: phase.projectId,
        subscriptionId: phase.subscriptionId,
        subscriptionPhaseId: phase.id,
        subscriptionItemId: item.id,
        status: "pending" as const,
        type: "isTrial" in w && w.isTrial ? ("trial" as const) : ("normal" as const),
        cycleStartAt: w.start,
        cycleEndAt: w.end,
        processingAt: null,
        invoiceId: null,
        amountEstimateCents: null,
        prorationFactor: null,
        reason: "isTrial" in w && w.isTrial ? "trial" : null,
        createdAt: now,
        updatedAt: now,
      }))

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

  // get the last open invoices to update the openInvoices
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
    phasesProcessed: phases.length,
    subscription,
    hasDueBillingPeriods: !!lastDueBillingPeriods,
  }
}
