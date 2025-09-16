import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq, inArray, sql } from "@unprice/db"
import { invoiceItems, invoices } from "@unprice/db/schema"
import { AesGCM, hashStringSHA256 } from "@unprice/db/utils"
import {
  type CollectionMethod,
  type Currency,
  type Customer,
  type FeatureType,
  type InvoiceItemExtended,
  type InvoiceStatus,
  type PaymentProvider,
  type SubscriptionInvoice,
  calculatePricePerFeature,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { env } from "../../env"
import { PaymentProviderService } from "../payment-provider"

import type { CustomerService } from "../customers"
import { db } from "../utils/db"
import { UnPriceSubscriptionError } from "./errors"

interface ValidatePaymentMethodResult {
  paymentMethodId: string | null
  requiredPaymentMethod: boolean
}

/**
 * Validates the payment method status for a customer
 * @param customer - Customer information
 * @param paymentProvider - Optional payment provider
 * @param requiredPaymentMethod - Whether payment method is required
 * @param logger - Logger instance
 * @returns Payment method validation result
 */
export async function validatePaymentMethod({
  customer,
  paymentProvider,
  requiredPaymentMethod = false,
  logger,
}: {
  customer: Customer
  paymentProvider?: PaymentProvider
  requiredPaymentMethod?: boolean
  logger: Logger
}): Promise<ValidatePaymentMethodResult> {
  // If payment method is not required or no provider, return early
  if (!requiredPaymentMethod || !paymentProvider) {
    return {
      paymentMethodId: null,
      requiredPaymentMethod: false,
    }
  }

  // Get active payment provider config
  const config = await db.query.paymentProviderConfig.findFirst({
    where: (config, { and, eq }) =>
      and(
        eq(config.projectId, customer.projectId),
        eq(config.paymentProvider, paymentProvider),
        eq(config.active, true)
      ),
  })

  if (!config) {
    logger.error(
      `Payment provider config for this project ${customer.projectId} and payment provider ${paymentProvider} not found or not active`
    )
    throw new Error(
      `Payment provider config for this project ${customer.projectId} and payment provider ${paymentProvider} not found or not active`
    )
  }

  // Decrypt provider key
  const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)
  const decryptedKey = await aesGCM.decrypt({
    iv: config.keyIv,
    ciphertext: config.key,
  })

  // Initialize payment provider service
  const paymentProviderService = new PaymentProviderService({
    customer,
    paymentProvider,
    logger,
    token: decryptedKey,
  })

  const { err: paymentMethodErr, val: paymentMethodId } =
    await paymentProviderService.getDefaultPaymentMethodId()

  if (paymentMethodErr) {
    logger.error(
      `Payment validation failed: ${paymentMethodErr.message} for project ${customer.projectId} and payment provider ${paymentProvider}`
    )
    throw new Error(`Payment validation failed: ${paymentMethodErr.message}`)
  }

  if (requiredPaymentMethod && !paymentMethodId?.paymentMethodId) {
    logger.error(
      `Required payment method not found for project ${customer.projectId} and payment provider ${paymentProvider}`
    )
    throw new Error("Required payment method not found")
  }

  return {
    paymentMethodId: paymentMethodId.paymentMethodId,
    requiredPaymentMethod: true,
  }
}

interface FinalizeInvoiceResult {
  invoice: SubscriptionInvoice
}

// TODO: re evaludate if this should be inside the machine
// this is here and not inside the machine because it doesn't neccesarilly concern the status of the subscription
// if there is an error finilizing we report it to the machine
// takes the invoice that are due and in draft status and finilizes them
// basically sets up the usage per invoice items and updates the invoice status
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
}): Promise<Result<FinalizeInvoiceResult[], UnPriceSubscriptionError>> {
  const openInvoices = await db.query.invoices.findMany({
    with: {
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
      and(
        eq(inv.projectId, projectId),
        eq(inv.subscriptionId, subscriptionId),
        inArray(inv.status, ["draft"]),
        lte(inv.dueAt, now)
      ),
    orderBy: (inv, { asc }) => asc(inv.dueAt),
  })

  if (openInvoices.length === 0) {
    return Ok([])
  }

  const results = [] as FinalizeInvoiceResult[]

  for (const invoice of openInvoices) {
    // only kind period or trial are supported
    // for getting the quantity and price
    const invoiceItemsToUpdate = invoice.invoiceItems
      .filter((item) => item.featurePlanVersionId !== null)
      .filter((item) => item.subscriptionItemId !== null)
      .filter((item) => item.kind === "period" || item.kind === "trial")

    if (invoiceItemsToUpdate.length === 0) {
      continue
    }

    const paymentProviderService = await customerService.getPaymentProvider({
      projectId,
      provider: invoice.paymentProvider,
    })

    if (paymentProviderService.err) {
      logger.error("Error getting payment provider", {
        invoiceId: invoice.id,
        projectId: invoice.projectId,
      })

      throw paymentProviderService.err
    }

    // compute the invoice items
    const { val: billableItems, err: billableItemsErr } = await computeInvoiceItems({
      invoice,
      items: invoiceItemsToUpdate as InvoiceItemExtended[],
      analytics,
      logger,
      paymentProviderService: paymentProviderService.val,
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

      // update the billing period to invoiced
      let totalAmount = 0

      for (const item of billableItems.items) {
        totalAmount += item.totalAmount
      }

      // TODO: should I add the credits, invoice url and id from provider, etc? HERE??

      // void the billing period if the total amount is 0 or proration factor is 0
      const statusInvoice = totalAmount === 0 ? ("void" as const) : ("unpaid" as const)

      const updatedInvoice = await tx
        .update(invoices)
        .set({ subtotal: totalAmount, total: totalAmount, status: statusInvoice, issueDate: now })
        .where(
          and(
            eq(invoices.id, invoice.id),
            eq(invoices.projectId, projectId),
            eq(invoices.subscriptionId, subscriptionId)
          )
        )
        .returning()
        .then((res) => res[0])

      if (!updatedInvoice) {
        return Err(new UnPriceSubscriptionError({ message: "Error updating invoice" }))
      }

      results.push({ invoice: updatedInvoice })
    })
  }

  // create the invoice in the payment provider

  // create the invoice items in the payment provider

  // set the status of the invoice as unpaid or void
  // set estimated amount and subtotal
  // apply credits
  // set the invoice payment provider id and url

  // get the last open invoice

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
  featureType: FeatureType
  productId: string
  totalAmount: number
  unitAmount: number
  subtotalAmount: number
  quantity: number
  prorate: number
  productSlug: string
  type: FeatureType
  description?: string
  metadata: {
    subscriptionItemId: string
  }
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
            logger.warn("usage not found", {
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
          featureType: item.featurePlanVersion.featureType,
          productId: item.featurePlanVersion.feature.id,
          productSlug: item.featurePlanVersion.feature.slug,
          prorate: item.prorationFactor,
          type: item.featurePlanVersion.featureType,
          description: description ?? "",
          metadata: {
            subscriptionItemId: item.subscriptionItemId ?? "",
          },
          cycleStartAt: item.cycleStartAt,
          cycleEndAt: item.cycleEndAt,
          quantity: quantity,
        })
      }
    }

    // order by feature type and cycle start at
    updatedItems.sort((a, b) => {
      if (a.featureType === b.featureType) {
        return a.cycleStartAt - b.cycleStartAt
      }
      return a.featureType.localeCompare(b.featureType)
    })

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
}): Promise<Result<FinalizeInvoiceResult, UnPriceSubscriptionError>> => {
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
    return Ok({
      invoice,
    })
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

      return Ok({
        invoice: updatedInvoice,
      })
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

      return Ok({
        invoice: updatedInvoice,
      })
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

    return Ok({
      invoice: updatedInvoice,
    })
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

    return Ok({
      invoice: updatedInvoice,
    })
  }

  return Err(new UnPriceSubscriptionError({ message: "Unsupported status for invoice" }))
}
