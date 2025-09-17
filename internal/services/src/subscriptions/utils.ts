import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq, gte, inArray, isNull, or, sql } from "@unprice/db"
import { creditGrants, invoiceCreditApplications, invoiceItems, invoices } from "@unprice/db/schema"
import { AesGCM, hashStringSHA256, newId } from "@unprice/db/utils"
import {
  type CollectionMethod,
  type Currency,
  type InvoiceItemExtended,
  type InvoiceStatus,
  type PaymentProvider,
  type SubscriptionInvoice,
  calculatePricePerFeature,
} from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { env } from "../../env"
import { PaymentProviderService } from "../payment-provider"

import type { Customer } from "@unprice/db/validators"
import type { CustomerService } from "../customers"
import { db } from "../utils/db"
import { UnPriceSubscriptionError } from "./errors"

export async function upsertPaymentProviderInvoice(opts: {
  db: Database
  logger: Logger
  paymentProviderService: PaymentProviderService
  invoice: SubscriptionInvoice
  customer: Customer
  items: InvoiceItemExtended[]
}): Promise<
  Result<
    { providerInvoiceId?: string; providerInvoiceUrl?: string },
    UnPriceSubscriptionError | FetchError
  >
> {
  const { default: pLimit } = await import("p-limit")
  const { db, logger, paymentProviderService, invoice, items, customer } = opts

  // if the total amount is 0 we skip
  if ((invoice.total ?? 0) === 0) return Ok({})

  const description = `Invoice ${invoice.statementDateString}`
  const customFields = [
    { name: "Billing Period", value: invoice.statementDateString },
    { name: "statementKey", value: invoice.statementKey },
  ]
  const basePayload = {
    currency: invoice.currency,
    collectionMethod: invoice.collectionMethod,
    customerName: customer.name,
    email: customer.email,
    description,
    dueDate: invoice.dueAt ?? undefined,
    customFields,
  } as const

  let providerInvoiceId = invoice.invoicePaymentProviderId ?? ""
  let providerInvoiceUrl = invoice.invoicePaymentProviderUrl ?? ""

  // upsert provider invoice
  if (!providerInvoiceId) {
    const created = await paymentProviderService.createInvoice(basePayload)

    if (created.err) {
      return Err(
        new UnPriceSubscriptionError({ message: `createInvoice failed: ${created.err.message}` })
      )
    }
    providerInvoiceId = created.val?.invoiceId ?? ""
    providerInvoiceUrl = created.val?.invoiceUrl ?? ""
  } else {
    const updated = await paymentProviderService.updateInvoice({
      invoiceId: providerInvoiceId,
      collectionMethod: basePayload.collectionMethod,
      description: basePayload.description,
      dueDate: basePayload.dueDate,
      customFields: basePayload.customFields,
    })

    if (updated.err) {
      return Err(
        new UnPriceSubscriptionError({ message: `updateInvoice failed: ${updated.err.message}` })
      )
    }

    providerInvoiceUrl = updated.val?.invoiceUrl ?? ""
  }

  // Reconcile items by subscriptionItemId metadata
  const current = await paymentProviderService.getInvoice({ invoiceId: providerInvoiceId })

  if (current.err) {
    return Err(
      new UnPriceSubscriptionError({ message: `getInvoice failed: ${current.err.message}` })
    )
  }

  const bySubId = new Map<string, string>()
  let creditLineId: string | undefined

  // get the existing invoice item id by subscription item id and credit line id
  for (const it of current.val.items) {
    const subId = it.metadata?.subscriptionItemId
    if (subId) bySubId.set(subId, it.id)

    // get the credit line id
    if (it.metadata?.kind === "credit_applied" && it.metadata?.invoiceId === invoice.id) {
      creditLineId = it.id
    }
  }

  // Upsert line items with bounded concurrency
  const limit = pLimit(10) // 10 is the max number of concurrent requests to the payment provider
  const tasks: Promise<unknown>[] = []

  for (const item of items) {
    // if the total amount and subtotal amount are 0 we skip the creation of the invoice item
    if (item.amountTotal === 0 && item.amountSubtotal === 0) continue
    const subId = item.subscriptionItemId ?? ""
    const isProrated = (item.prorationFactor ?? 1) !== 1
    // get the existing invoice item id by subscription item id
    const existingId = subId ? bySubId.get(subId) : undefined

    if (existingId) {
      tasks.push(
        limit(async () => {
          const res = await paymentProviderService.updateInvoiceItem({
            invoiceItemId: existingId,
            totalAmount: item.amountTotal,
            name: item.description ?? "",
            isProrated,
            quantity: item.quantity,
            // add the subscription item id to the metadata to be able to update the invoice item
            metadata: subId ? { subscriptionItemId: subId } : undefined,
            description: item.description ?? "",
          })
          if (res.err) throw new Error(`updateInvoiceItem failed: ${res.err.message}`)
        })
      )
    } else {
      tasks.push(
        limit(async () => {
          const res = await paymentProviderService.addInvoiceItem({
            invoiceId: providerInvoiceId,
            name: item.featurePlanVersion.feature.slug,
            // each product is created from the feature
            productId: item.featurePlanVersion.feature.id,
            description: item.description ?? "",
            isProrated,
            totalAmount: item.amountTotal,
            unitAmount: item.unitAmountCents ?? undefined, // ignored in amount-path by provider
            quantity: item.quantity,
            currency: invoice.currency,
            metadata: subId ? { subscriptionItemId: subId } : undefined,
          })
          if (res.err) throw new Error(`addInvoiceItem failed: ${res.err.message}`)
        })
      )
    }
  }

  // apply credits
  if (
    invoice.amountCreditUsed &&
    invoice.amountCreditUsed > 0 &&
    invoice.total &&
    invoice.total > 0
  ) {
    const credit = invoice.amountCreditUsed
    tasks.push(
      limit(async () => {
        if (creditLineId) {
          const res = await paymentProviderService.updateInvoiceItem({
            invoiceItemId: creditLineId,
            totalAmount: -credit,
            name: "Credits applied",
            isProrated: false,
            quantity: 1,
            metadata: { kind: "credit_applied", invoiceId: invoice.id },
            description: "Customer credits applied",
          })
          if (res.err) throw new Error(`updateInvoiceItem(credit) failed: ${res.err.message}`)
        } else {
          const res = await paymentProviderService.addInvoiceItem({
            invoiceId: providerInvoiceId,
            name: "Credits applied",
            description: "Customer credits applied",
            isProrated: false,
            totalAmount: -credit, // negative
            unitAmount: -credit, // ensure Stripe wrapper uses 'amount' for no-product items
            quantity: 1,
            currency: invoice.currency,
            metadata: { kind: "credit_applied", invoiceId: invoice.id },
          })
          if (res.err) throw new Error(`addInvoiceItem(credit) failed: ${res.err.message}`)
        }
      })
    )
  }

  // Execute all item upserts
  try {
    await Promise.all(tasks)
  } catch (e) {
    const error = e as Error
    logger.error("Provider item upsert failed", { error: error.message, invoiceId: invoice.id })
    return Err(new UnPriceSubscriptionError({ message: error.message }))
  }

  // Re-fetch to validate totals and capture item IDs for persistence
  const verify = await paymentProviderService.getInvoice({ invoiceId: providerInvoiceId })
  if (verify.err) {
    return Err(
      new UnPriceSubscriptionError({
        message: `getInvoice verification failed: ${verify.err.message}`,
      })
    )
  }

  if ((verify.val.total ?? 0) !== (invoice.total ?? 0)) {
    logger.error("Provider invoice total mismatch", {
      invoiceId: invoice.id,
      providerInvoiceId,
      internalTotal: invoice.total,
      providerTotal: verify.val.total,
    })
    return Err(
      new UnPriceSubscriptionError({ message: "Provider total does not match internal total" })
    )
  }

  // Finalize provider invoice (no send/charge here)
  const fin = await paymentProviderService.finalizeInvoice({ invoiceId: providerInvoiceId })
  if (fin.err)
    return Err(
      new UnPriceSubscriptionError({ message: `finalizeInvoice failed: ${fin.err.message}` })
    )

  // Persist provider ids and item provider ids using the last snapshot (no remote calls in tx)
  const providerItemBySub = new Map<string, string>()
  for (const it of verify.val.items) {
    const subId = it.metadata?.subscriptionItemId
    if (subId) providerItemBySub.set(subId, it.id)
  }

  // Persist provider ids in a short tx
  await db.transaction(async (tx) => {
    await tx
      .update(invoices)
      .set({
        invoicePaymentProviderId: providerInvoiceId,
        invoicePaymentProviderUrl: providerInvoiceUrl,
      })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.projectId, invoice.projectId)))

    for (const item of items) {
      const subId = item.subscriptionItemId ?? ""
      const id = subId ? providerItemBySub.get(subId) : undefined
      if (!id) continue
      await tx
        .update(invoiceItems)
        .set({ itemProviderId: id })
        .where(and(eq(invoiceItems.id, item.id), eq(invoiceItems.projectId, item.projectId)))
    }
  })

  return Ok({ providerInvoiceId, providerInvoiceUrl })
}

/**
 * Applies available customer credits to an invoice total.
 * - Picks active, non-expired grants (same currency/provider), FIFO by earliest expiry.
 * - Creates `invoice_credit_applications`, updates `credit_grants.amount_used` (+deactivate when fully used).
 * - Updates `invoices.amountCreditUsed` and `invoices.total` accordingly.
 */
export async function applyCredits(input: {
  db: Database
  invoice: SubscriptionInvoice
  now: number
}): Promise<
  Result<
    {
      applied: number
      remainingInvoiceTotal: number
      applications: { grantId: string; amount: number }[]
    },
    UnPriceSubscriptionError | FetchError
  >
> {
  const { db, invoice, now } = input

  return db.transaction(async (tx) => {
    const { projectId, customerId, id: invoiceId, currency, paymentProvider } = invoice

    // Nothing to apply if already zero or void/paid
    const currentCredit = invoice.amountCreditUsed ?? 0
    const currentTotal = invoice.total ?? 0
    if (currentTotal <= 0 || ["void", "paid"].includes(invoice.status)) {
      return Ok({ applied: 0, remainingInvoiceTotal: currentTotal, applications: [] })
    }

    // Eligible credit grants (active, not expired, with available > 0)
    const grants = await tx.query.creditGrants.findMany({
      where: (g, { and, eq, or, isNull, gt }) =>
        and(
          eq(g.projectId, projectId),
          eq(g.customerId, customerId),
          // credit grants are always in the same currency and payment provider
          eq(g.currency, currency),
          eq(g.paymentProvider, paymentProvider),
          eq(g.active, true),
          or(isNull(g.expiresAt), gt(g.expiresAt, now))
        ),
      orderBy: (g, { asc }) => asc(g.expiresAt), // FIFO by earliest expiry
    })

    let remaining = currentTotal
    let applied = 0
    const applications: { grantId: string; amount: number }[] = []

    for (const grant of grants) {
      if (remaining <= 0) break
      const available = Math.max(0, grant.totalAmount - grant.amountUsed)
      if (available <= 0) continue

      const toApply = Math.min(available, remaining)
      if (toApply <= 0) continue

      // Record application
      await tx.insert(invoiceCreditApplications).values({
        id: newId("invoice_credit_application"),
        projectId,
        invoiceId,
        creditGrantId: grant.id,
        amountApplied: toApply,
      })

      // Update grant usage (deactivate if fully used)
      const newUsed = grant.amountUsed + toApply
      await tx
        .update(creditGrants)
        .set({
          amountUsed: newUsed,
          active: newUsed < grant.totalAmount,
        })
        .where(and(eq(creditGrants.id, grant.id), eq(creditGrants.projectId, projectId)))

      applied += toApply
      remaining -= toApply
      applications.push({ grantId: grant.id, amount: toApply })
    }

    if (applied === 0) {
      return Ok({ applied: 0, remainingInvoiceTotal: currentTotal, applications })
    }

    // Update invoice totals
    const newAmountCreditUsed = currentCredit + applied
    const newTotal = Math.max(0, (invoice.subtotal ?? 0) - newAmountCreditUsed)

    await tx
      .update(invoices)
      .set({
        amountCreditUsed: newAmountCreditUsed,
        total: newTotal,
        metadata: { ...(invoice.metadata ?? {}), credits: "Credits applied" },
      })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.projectId, projectId)))

    return Ok({ applied, remainingInvoiceTotal: newTotal, applications })
  })
}

// only compute/persist amounts, apply credits, create/update/finalize the provider invoice.
export async function finalizeInvoice({
  subscriptionId,
  projectId,
  now,
  logger,
  db,
  analytics,
  customerService,
}: {
  subscriptionId: string
  projectId: string
  now: number
  logger: Logger
  db: Database
  analytics: Analytics
  customerService: CustomerService
}): Promise<Result<SubscriptionInvoice[], UnPriceSubscriptionError>> {
  const openInvoices = await db.query.invoices.findMany({
    with: {
      customer: true,
      invoiceItems: {
        with: {
          featurePlanVersion: {
            with: {
              feature: true,
            },
          },
        },
      },
    },
    where: (inv, { and, eq, inArray, lte }) =>
      or(
        // for invoices that have not been finilized yet
        and(
          eq(inv.projectId, projectId),
          eq(inv.subscriptionId, subscriptionId),
          eq(inv.status, "draft"),
          gte(inv.dueAt, now)
        ),
        // for invoices that have been finilized but not sent to the payment provider
        and(
          eq(inv.projectId, projectId),
          eq(inv.subscriptionId, subscriptionId),
          inArray(inv.status, ["unpaid", "waiting"]),
          isNull(inv.invoicePaymentProviderId),
          lte(inv.dueAt, now)
        )
      ),
    orderBy: (inv, { asc }) => asc(inv.dueAt),
  })

  if (openInvoices.length === 0) {
    return Err(new UnPriceSubscriptionError({ message: "No open invoices found" }))
  }

  const results = [] as SubscriptionInvoice[]

  // collect async tasks to run after the transaction commits
  const postCommitTasks: Array<() => Promise<void>> = []

  for (const invoice of openInvoices) {
    // only kind period or trial are supported
    // for getting the quantity and price
    // TODO: we need to handle the other cases as well
    const invoiceItemsToUpdate = invoice.invoiceItems
      .filter((item) => item.featurePlanVersionId !== null)
      .filter((item) => item.subscriptionItemId !== null)
      .filter((item) => item.kind === "period" || item.kind === "trial")

    if (invoiceItemsToUpdate.length === 0) {
      continue
    }

    const { err: paymentProviderServiceErr, val: paymentProviderService } =
      await customerService.getPaymentProvider({
        projectId,
        provider: invoice.paymentProvider,
      })

    if (paymentProviderServiceErr) {
      logger.error("Error getting payment provider", {
        invoiceId: invoice.id,
        projectId: invoice.projectId,
      })

      throw paymentProviderServiceErr
    }

    // compute the invoice items for getting the right quantities and prices
    const { val: billableItems, err: billableItemsErr } = await computeInvoiceItems({
      invoice,
      items: invoiceItemsToUpdate as InvoiceItemExtended[],
      analytics,
      logger,
      paymentProviderService: paymentProviderService,
    })

    if (billableItemsErr) {
      logger.error("Error computing invoice items", {
        statementKey: invoice.statementKey,
        subscriptionId: invoice.subscriptionId,
        projectId: invoice.projectId,
        customerId: invoice.customerId,
      })

      throw billableItemsErr
    }

    // all this happends in a transaction
    await db.transaction(async (tx) => {
      const invoiceItemsIds = billableItems.items.map((item) => item.id)

      // we update in a single query
      const quantityChunks = []
      const totalAmountChunks = []
      const unitAmountChunks = []
      const subtotalAmountChunks = []
      const descriptionChunks = []

      quantityChunks.push(sql`(case`)
      totalAmountChunks.push(sql`(case`)
      unitAmountChunks.push(sql`(case`)
      subtotalAmountChunks.push(sql`(case`)
      descriptionChunks.push(sql`(case`)

      for (const item of billableItems.items) {
        quantityChunks.push(
          sql`when ${invoiceItems.id} = ${item.id} then cast(${item.quantity} as int)`
        )
        totalAmountChunks.push(
          sql`when ${invoiceItems.id} = ${item.id} then cast(${item.totalAmount} as int)`
        )
        unitAmountChunks.push(
          sql`when ${invoiceItems.id} = ${item.id} then cast(${item.unitAmount} as int)`
        )
        subtotalAmountChunks.push(
          sql`when ${invoiceItems.id} = ${item.id} then cast(${item.subtotalAmount} as int)`
        )
        descriptionChunks.push(sql`when ${invoiceItems.id} = ${item.id} then ${item.description}`)
      }

      // add end) to the chunks
      quantityChunks.push(sql`end)`)
      totalAmountChunks.push(sql`end)`)
      unitAmountChunks.push(sql`end)`)
      subtotalAmountChunks.push(sql`end)`)
      descriptionChunks.push(sql`end)`)

      const sqlQueryQuantity = sql.join(quantityChunks, sql.raw(" "))
      const sqlQueryTotalAmount = sql.join(totalAmountChunks, sql.raw(" "))
      const sqlQueryUnitAmount = sql.join(unitAmountChunks, sql.raw(" "))
      const sqlQuerySubtotalAmount = sql.join(subtotalAmountChunks, sql.raw(" "))
      const sqlQueryDescription = sql.join(descriptionChunks, sql.raw(" "))

      // for every invoice item we update the invoice item
      await tx
        .update(invoiceItems)
        .set({
          quantity: sqlQueryQuantity,
          unitAmountCents: sqlQueryUnitAmount,
          amountTotal: sqlQueryTotalAmount,
          amountSubtotal: sqlQuerySubtotalAmount,
          description: sqlQueryDescription,
        })
        .where(
          and(
            eq(invoiceItems.invoiceId, invoice.id),
            eq(invoiceItems.projectId, projectId),
            inArray(invoiceItems.id, invoiceItemsIds)
          )
        )

      // get the subtotal amount
      const subtotalAmount = billableItems.items.reduce((a, i) => a + i.subtotalAmount, 0)
      const totalAmount = billableItems.items.reduce((a, i) => a + i.totalAmount, 0)

      // apply credits
      const { err: applyCreditsErr, val: applyCreditsResult } = await applyCredits({
        db: tx, // execute in the same transaction
        invoice: { ...invoice, subtotal: subtotalAmount, total: totalAmount },
        now,
      })

      if (applyCreditsErr) {
        logger.error("Error applying credits", {
          invoiceId: invoice.id,
          projectId: invoice.projectId,
        })
        throw applyCreditsErr
      }

      const finalTotalAmount = applyCreditsResult.remainingInvoiceTotal
      const finalSubtotalAmount = subtotalAmount - applyCreditsResult.applied

      // void the billing period if the total amount is 0 or proration factor is 0
      const statusInvoice = totalAmount === 0 ? ("void" as const) : ("unpaid" as const)

      // update the invoice
      await tx
        .update(invoices)
        .set({
          subtotal: finalSubtotalAmount,
          total: finalTotalAmount,
          status: statusInvoice,
          issueDate: now,
          metadata: {
            ...(invoice.metadata ?? {}),
            note: "Finilized by scheduler",
          },
        })
        .where(
          and(
            eq(invoices.id, invoice.id),
            eq(invoices.projectId, projectId),
            eq(invoices.subscriptionId, subscriptionId)
          )
        )

      // get the updated invoice with items
      const updatedInvoice = await tx.query.invoices.findFirst({
        with: {
          customer: true,
          invoiceItems: {
            with: {
              featurePlanVersion: {
                with: {
                  feature: true,
                },
              },
            },
          },
        },
        where: and(eq(invoices.id, invoice.id), eq(invoices.projectId, projectId)),
      })

      if (!updatedInvoice) {
        return Err(new UnPriceSubscriptionError({ message: "Error updating invoice" }))
      }

      // if void then skip creation and return the invoice
      // create the invoice in the payment provider
      // create the invoice items in the payment provider
      // set the invoice payment provider id and url
      // get the last open invoice

      if (statusInvoice === "void") {
        results.push(updatedInvoice)
        return
      }

      // Note: Avoid remote calls inside this transaction; push work to be executed after commit
      // We push a thunk to be executed after the transaction completes successfully
      postCommitTasks.push(async () => {
        const { err: processInvoiceErr } = await upsertPaymentProviderInvoice({
          db,
          logger,
          invoice: updatedInvoice,
          customer: updatedInvoice.customer,
          items: updatedInvoice.invoiceItems.map((item) => ({
            ...item,
            featurePlanVersion: item.featurePlanVersion!,
          })),
          paymentProviderService: paymentProviderService,
        })

        if (processInvoiceErr) {
          logger.error("Error processing invoice", {
            invoiceId: updatedInvoice.id,
            projectId: updatedInvoice.projectId,
          })
          throw processInvoiceErr
        }

        results.push(updatedInvoice)
      })
    })
  }

  // TODO: we have to update the estimated amount of billing periods
  // with computeInvoiceItems as a separete step

  // Execute post-commit remote calls with bounded concurrency
  if (postCommitTasks.length > 0) {
    const { default: pLimit } = await import("p-limit")
    const limit = pLimit(3)
    const exec = postCommitTasks.map((t: () => Promise<void>) => limit(() => t()))
    await Promise.all(exec)
  }

  return Ok(results)
}

// all variables that affect the invoice should be included in the statement key
// this way we can group invoices together and bill them together
// this is useful for co-billing and for the invoice scheduler
// also helps us invoice phases changes when they share the same variables,
// or split them into multiple invoices we things like currency and payment provider changes
export async function computeStatementKey(input: {
  projectId: string
  customerId: string
  subscriptionId: string
  invoiceAt: number // epoch ms
  currency: Currency
  paymentProvider: PaymentProvider
  collectionMethod: CollectionMethod
}): Promise<string> {
  const raw = [
    input.projectId,
    input.customerId,
    input.subscriptionId,
    String(input.invoiceAt),
    input.currency,
    input.paymentProvider,
    input.collectionMethod,
  ].join("|")
  return hashStringSHA256(raw)
}

interface ComputeInvoiceItemsResult {
  id: string
  totalAmount: number
  unitAmount: number
  subtotalAmount: number
  quantity: number
  prorate: number
  description?: string
  cycleStartAt: number
  cycleEndAt: number
}

export const computeInvoiceItems = async (payload: {
  invoice: SubscriptionInvoice
  items: InvoiceItemExtended[]
  analytics: Analytics
  logger: Logger
  paymentProviderService: PaymentProviderService
}): Promise<
  Result<
    {
      items: ComputeInvoiceItemsResult[]
    },
    UnPriceSubscriptionError
  >
> => {
  const { invoice, items, analytics, logger, paymentProviderService } = payload

  // from the invoice items we can get different cycle groups
  // lets group them by cycle start at and end at
  // for instance when we have a change in midcycle we have different periods for every item
  const cycleGroups = items.reduce(
    (acc, item) => {
      const key = `${item.cycleStartAt}-${item.cycleEndAt}`
      if (!acc[key]) {
        acc[key] = []
      }
      acc[key].push(item)
      return acc
    },
    {} as Record<string, InvoiceItemExtended[]>
  )

  const updatedItems = [] as ComputeInvoiceItemsResult[]

  try {
    for (const cycleKey of Object.keys(cycleGroups)) {
      const [cycleStartAt, cycleEndAt] = cycleKey.split("-").map(Number) as [number, number]
      const cycleGroup = cycleGroups[cycleKey]!

      const usageItems = cycleGroup
        .filter(
          (item) => item.subscriptionItemId && item.featurePlanVersion.featureType === "usage"
        )
        .map((item) => ({
          // subscriptionItemId is not null because we filter the items to bill
          subscriptionItemId: item.subscriptionItemId!,
          aggregationMethod: item.featurePlanVersion.aggregationMethod,
          featureType: item.featurePlanVersion.featureType,
        }))

      // get the usage for the cycle in one call
      const usages = await analytics.getUsageBillingSubscriptionItems({
        customerId: invoice.customerId,
        projectId: invoice.projectId,
        subscriptionItems: usageItems,
        startAt: cycleStartAt,
        endAt: cycleEndAt,
      })

      // if usages failed, return an error
      if (!usages) {
        return Err(new UnPriceSubscriptionError({ message: "Error getting usages" }))
      }

      let quantity = 0

      // iterate on every item in the cycle group
      for (const item of cycleGroup) {
        if (item.subscriptionItemId && item.featurePlanVersion.featureType === "usage") {
          const usage = usages?.find(
            (usage) => usage.subscriptionItemId === item.subscriptionItemId
          )

          // TODO: how can I be sure that the usage is not null?
          if (!usage) {
            logger.debug("usage not found", {
              itemId: item.subscriptionItemId,
              featureType: item.featurePlanVersion.featureType,
            })
          }

          // if the aggregation method is _all we get the usage for all time
          quantity = item.featurePlanVersion.aggregationMethod.endsWith("_all")
            ? (usage?.accumulatedUsage ?? 0)
            : (usage?.usage ?? 0)
        } else {
          // non usage features have the same quantity for the whole cycle
          quantity = item.quantity
        }

        // this should never happen but we add a check anyway just in case
        if (quantity < 0) {
          logger.error("quantity is negative", {
            itemId: item.subscriptionItemId,
            featureType: item.featurePlanVersion.featureType,
            quantity,
          })

          // throw and cancel execution
          return Err(
            new UnPriceSubscriptionError({
              message: `quantity is negative ${item.subscriptionItemId} ${item.featurePlanVersion.featureType} ${quantity}`,
            })
          )
        }

        let totalAmount = 0
        let unitAmount = 0
        let subtotalAmount = 0
        // calculate the price depending on the type of feature
        const { val: priceCalculation, err: priceCalculationErr } = calculatePricePerFeature({
          config: item.featurePlanVersion.config,
          featureType: item.featurePlanVersion.featureType,
          quantity: quantity,
          prorate: item.prorationFactor,
        })

        if (priceCalculationErr) {
          logger.error("error calculating price", {
            itemId: item.id,
            featureSlug: item.featurePlanVersion.feature.slug,
            error: priceCalculationErr.message,
          })

          return Err(
            new UnPriceSubscriptionError({
              message: `Error calculating price for item ${item.subscriptionItemId}`,
            })
          )
        }

        const { val: formattedTotalAmount, err: formattedTotalAmountErr } =
          paymentProviderService.formatAmount(priceCalculation.totalPrice.dinero)
        const { val: formattedUnitAmount, err: formattedUnitAmountErr } =
          paymentProviderService.formatAmount(priceCalculation.unitPrice.dinero)
        const { val: formattedSubtotalAmount, err: formattedSubtotalAmountErr } =
          paymentProviderService.formatAmount(priceCalculation.subtotalPrice.dinero)

        if (formattedTotalAmountErr || formattedUnitAmountErr || formattedSubtotalAmountErr) {
          return Err(
            new UnPriceSubscriptionError({
              message: `Error formatting amount: ${
                formattedTotalAmountErr?.message ?? formattedUnitAmountErr?.message
              }`,
            })
          )
        }

        // the totals takes into account the proration factor
        unitAmount = formattedUnitAmount.amount
        subtotalAmount = formattedSubtotalAmount.amount
        totalAmount = formattedTotalAmount.amount

        // give good description per item type so the customer can identify the charge
        // take into account if the charge is prorated or not
        // add the period of the charge if prorated
        let description = undefined

        if (item.featurePlanVersion.featureType === "usage") {
          description = `${item.featurePlanVersion.feature.title.toUpperCase()} - usage`
        } else if (item.featurePlanVersion.featureType === "flat") {
          description = `${item.featurePlanVersion.feature.title.toUpperCase()} - flat`
        } else if (item.featurePlanVersion.featureType === "tier") {
          description = `${item.featurePlanVersion.feature.title.toUpperCase()} - tier`
        } else if (item.featurePlanVersion.featureType === "package") {
          // package is a special case, we need to calculate the quantity of packages the customer bought
          // we do it after the price calculation because we pass the package units to the payment provider
          const quantityPackages = Math.ceil(quantity / item.featurePlanVersion.config?.units!)
          quantity = quantityPackages
          description = `${item.featurePlanVersion.feature.title.toUpperCase()} - ${quantityPackages} package of ${item
            .featurePlanVersion.config?.units!} units`
        }

        if (item.prorationFactor !== 1) {
          const billingPeriod = `${new Date(item.cycleStartAt).toISOString().split("T")[0]} to ${
            new Date(item.cycleEndAt).toISOString().split("T")[0]
          }`

          description +=
            item.kind === "trial" ? ` trial (${billingPeriod})` : ` prorated (${billingPeriod})`
        }

        updatedItems.push({
          id: item.id,
          totalAmount: totalAmount,
          unitAmount: unitAmount,
          subtotalAmount: subtotalAmount,
          prorate: item.prorationFactor,
          description: description ?? "",
          cycleStartAt: item.cycleStartAt,
          cycleEndAt: item.cycleEndAt,
          quantity: quantity,
        })
      }
    }

    return Ok({
      items: updatedItems,
    })
  } catch (e) {
    const error = e as Error
    logger.error("error calculating invoice items price", {
      error: error.message,
    })
    return Err(new UnPriceSubscriptionError({ message: `Unhandled error: ${error.message}` }))
  }
}

export const collectInvoicePayment = async (payload: {
  invoiceId: string
  projectId: string
  logger: Logger
  now: number
}): Promise<Result<SubscriptionInvoice, UnPriceSubscriptionError>> => {
  const { invoiceId, projectId, logger, now } = payload

  // Get invoice details
  const invoice = await db.query.invoices.findFirst({
    where: (table, { eq, and }) => and(eq(table.id, invoiceId), eq(table.projectId, projectId)),
  })

  if (!invoice) {
    return Err(new UnPriceSubscriptionError({ message: "Invoice not found" }))
  }

  const MAX_PAYMENT_ATTEMPTS = 10
  const invoicePaymentProviderId = invoice.invoicePaymentProviderId
  const paymentMethodId = invoice.paymentMethodId

  // if the invoice is draft, we can't collect the payment
  if (invoice.status === "draft") {
    return Err(
      new UnPriceSubscriptionError({ message: "Invoice is not finalized, cannot collect payment" })
    )
  }

  // check if the invoice is already paid or void
  if (["paid", "void"].includes(invoice.status)) {
    return Ok(invoice)
  }

  // validate if the invoice is failed
  if (invoice.status === "failed") {
    // meaning the invoice is past due and we cannot collect the payment with 3 attempts
    return Err(
      new UnPriceSubscriptionError({ message: "Invoice is failed, cannot collect payment" })
    )
  }

  // check if the invoice has an invoice id from the payment provider
  if (!invoicePaymentProviderId) {
    return Err(
      new UnPriceSubscriptionError({
        message:
          "Invoice has no invoice id from the payment provider, please finalize the invoice first",
      })
    )
  }

  // check if the invoice has a payment method id
  // this shouldn't happen but we add a check anyway just in case
  if (!paymentMethodId || paymentMethodId === "") {
    return Err(
      new UnPriceSubscriptionError({
        message: "Invoice requires a payment method, please set a payment method first",
      })
    )
  }

  // Get subscription data with related entities
  const subscriptionData = await db.query.subscriptions.findFirst({
    where: (table, { eq, and }) =>
      and(eq(table.id, invoice.subscriptionId), eq(table.projectId, projectId)),
    with: {
      customer: true,
      phases: {
        where(fields, operators) {
          return operators.and(operators.eq(fields.projectId, projectId))
        },
        with: {
          planVersion: true,
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
    },
  })

  if (!subscriptionData) {
    return Err(new UnPriceSubscriptionError({ message: "Subscription not found" }))
  }

  const { phases, customer } = subscriptionData
  const phase = phases[0]

  if (!phase) {
    return Err(
      new UnPriceSubscriptionError({
        message: "Subscription phase not found",
      })
    )
  }

  // Get payment provider config
  const config = await db.query.paymentProviderConfig.findFirst({
    where: (config, { and, eq }) =>
      and(
        eq(config.projectId, customer.projectId),
        eq(config.paymentProvider, invoice.paymentProvider),
        eq(config.active, true)
      ),
  })

  if (!config) {
    return Err(
      new UnPriceSubscriptionError({
        message: "Payment provider config not found or not active",
      })
    )
  }

  // Initialize payment provider
  const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)
  const decryptedKey = await aesGCM.decrypt({
    iv: config.keyIv,
    ciphertext: config.key,
  })

  const paymentProviderService = new PaymentProviderService({
    customer,
    paymentProvider: invoice.paymentProvider,
    logger,
    token: decryptedKey,
  })

  // if the invoice is waiting, we need to check if the payment is successful
  // waiting mean we sent the invoice to the customer and we are waiting for the payment (manual payment)
  if (invoice.status === "waiting") {
    // check the status of the payment in the payment provider
    const statusPaymentProviderInvoice = await paymentProviderService.getStatusInvoice({
      invoiceId: invoicePaymentProviderId,
    })

    if (statusPaymentProviderInvoice.err) {
      return Err(new UnPriceSubscriptionError({ message: "Error getting invoice status" }))
    }

    // if the invoice is paid or void, we update the invoice status
    if (["paid", "void"].includes(statusPaymentProviderInvoice.val.status)) {
      // update the invoice status
      const updatedInvoice = await db
        .update(invoices)
        .set({
          status: statusPaymentProviderInvoice.val.status as InvoiceStatus,
          paidAt: statusPaymentProviderInvoice.val.paidAt,
          invoicePaymentProviderUrl: statusPaymentProviderInvoice.val.invoiceUrl,
          paymentAttempts: [
            ...(invoice.paymentAttempts ?? []),
            ...statusPaymentProviderInvoice.val.paymentAttempts,
          ],
          metadata: {
            ...(invoice.metadata ?? {}),
            reason: "payment_received",
            note:
              statusPaymentProviderInvoice.val.status === "paid"
                ? "Invoice paid successfully"
                : "Invoice voided",
          },
        })
        .where(eq(invoices.id, invoice.id))
        .returning()
        .then((res) => res[0])

      if (!updatedInvoice) {
        return Err(new UnPriceSubscriptionError({ message: "Error updating invoice" }))
      }

      return Ok(updatedInvoice)
    }

    // 3 attempts max for the invoice and the past due date is suppased
    if (
      (invoice.paymentAttempts?.length && invoice.paymentAttempts.length >= MAX_PAYMENT_ATTEMPTS) ||
      (invoice.pastDueAt && invoice.pastDueAt < now)
    ) {
      // update the invoice status
      const updatedInvoice = await db
        .update(invoices)
        .set({
          status: "failed",
          metadata: {
            reason: "pending_expiration",
            note: "Invoice has reached the maximum number of payment attempts and the past due date is suppased",
          },
        })
        .where(eq(invoices.id, invoice.id))
        .returning()
        .then((res) => res[0])

      if (!updatedInvoice) {
        return Err(new UnPriceSubscriptionError({ message: "Error updating invoice" }))
      }

      return Ok(updatedInvoice)
    }
  }

  // collect the payment depending on the collection method
  // collect automatically means we will try to collect the payment with the default payment method
  if (invoice.collectionMethod === "charge_automatically") {
    const stripePaymentInvoice = await paymentProviderService.collectPayment({
      invoiceId: invoicePaymentProviderId,
      paymentMethodId: paymentMethodId,
    })

    if (stripePaymentInvoice.err) {
      // update the attempt if the payment failed
      await db
        .update(invoices)
        .set({
          // set the intempts to failed
          paymentAttempts: [
            ...(invoice.paymentAttempts ?? []),
            { status: "failed", createdAt: Date.now() },
          ],
          metadata: {
            reason: "payment_failed",
            note: `Payment failed: ${stripePaymentInvoice.err.message}`,
          },
        })
        .where(eq(invoices.id, invoice.id))

      return Err(
        new UnPriceSubscriptionError({
          message: `Error collecting payment: ${stripePaymentInvoice.err.message}`,
        })
      )
    }

    const paymentStatus = stripePaymentInvoice.val.status
    const isPaid = ["paid", "void"].includes(paymentStatus)

    // update the invoice status if the payment is successful
    // if not add the failed attempt
    const updatedInvoice = await db
      .update(invoices)
      .set({
        status: isPaid ? "paid" : "unpaid",
        ...(isPaid ? { paidAt: Date.now() } : {}),
        ...(isPaid ? { invoicePaymentProviderUrl: stripePaymentInvoice.val.invoiceUrl } : {}),
        paymentAttempts: [
          ...(invoice.paymentAttempts ?? []),
          {
            status: isPaid ? "paid" : paymentStatus,
            createdAt: Date.now(),
          },
        ],
        metadata: {
          ...(invoice.metadata ?? {}),
          reason: isPaid ? "payment_received" : "payment_pending",
          note: isPaid ? "Invoice paid successfully" : `Payment pending for ${paymentStatus}`,
        },
      })
      .where(eq(invoices.id, invoice.id))
      .returning()
      .then((res) => res[0])

    if (!updatedInvoice) {
      return Err(new UnPriceSubscriptionError({ message: "Error updating invoice" }))
    }

    return Ok(updatedInvoice)
  }

  // send the invoice to the customer and wait for the payment
  if (invoice.collectionMethod === "send_invoice") {
    const stripeSendInvoice = await paymentProviderService.sendInvoice({
      invoiceId: invoicePaymentProviderId,
    })

    if (stripeSendInvoice.err) {
      return Err(
        new UnPriceSubscriptionError({
          message: `Error sending invoice: ${stripeSendInvoice.err.message}`,
        })
      )
    }

    // update the invoice status if send invoice is successful
    const updatedInvoice = await db
      .update(invoices)
      .set({
        status: "waiting",
        sentAt: Date.now(),
        metadata: {
          ...(invoice.metadata ?? {}),
          reason: "payment_pending",
          note: "Invoice sent to the customer, waiting for payment",
        },
      })
      .where(eq(invoices.id, invoice.id))
      .returning()
      .then((res) => res[0])

    if (!updatedInvoice) {
      return Err(new UnPriceSubscriptionError({ message: "Error updating invoice" }))
    }

    return Ok(updatedInvoice)
  }

  return Err(new UnPriceSubscriptionError({ message: "Unsupported status for invoice" }))
}
