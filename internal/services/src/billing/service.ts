import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq, inArray, sql } from "@unprice/db"
import {
  billingPeriods,
  creditGrants,
  invoiceCreditApplications,
  invoiceItems,
  invoices,
} from "@unprice/db/schema"
import {
  currencies,
  dinero,
  formatAmountDinero,
  formatMoney,
  hashStringSHA256,
  newId,
} from "@unprice/db/utils"
import {
  type AggregationMethod,
  type CalculatedPrice,
  type CollectionMethod,
  type Currency,
  type Customer,
  type Entitlement,
  type EntitlementState,
  type FeatureType,
  type InvoiceItemExtended,
  type InvoiceStatus,
  type PaymentProvider,
  type SubscriptionInvoice,
  calculateCycleWindow,
  calculateFreeUnits,
  calculateNextNCycles,
  calculatePricePerFeature,
  calculateProration,
  type grantSchemaExtended,
} from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { addDays } from "date-fns"
import type { z } from "zod"
import type { Cache } from "../cache"
import { CustomerService } from "../customers/service"
import { GrantsManager } from "../entitlements"
import type { Metrics } from "../metrics"
import { SubscriptionMachine } from "../subscriptions/machine"
import { SubscriptionLock } from "../subscriptions/subscriptionLock"
import { UnPriceBillingError } from "./errors"

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

interface ComputeCurrentUsageResult {
  grantId: string | null
  price: CalculatedPrice
  prorate: number
  cycleStartAt: number
  cycleEndAt: number
  usage: number
  included: number
  limit: number
  isTrial: boolean
}

export class BillingService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private customerService: CustomerService
  private grantsManager: GrantsManager

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.cache = cache
    this.metrics = metrics
    this.waitUntil = waitUntil
    this.customerService = new CustomerService({
      db,
      logger,
      analytics,
      waitUntil,
      cache,
      metrics,
    })
    this.grantsManager = new GrantsManager({
      db,
      logger,
    })
  }

  private async withSubscriptionMachine<T>(args: {
    subscriptionId: string
    projectId: string
    now: number
    // new options
    lock?: boolean
    ttlMs?: number
    run: (m: SubscriptionMachine) => Promise<T>
  }): Promise<T> {
    const { subscriptionId, projectId, now, run, lock: shouldLock = true, ttlMs = 30_000 } = args

    // create the lock if it should be locked
    const lock = shouldLock
      ? new SubscriptionLock({ db: this.db, projectId, subscriptionId })
      : null

    if (lock) {
      const acquired = await lock.acquire({
        ttlMs,
        now,
        staleTakeoverMs: 120_000,
        ownerStaleMs: ttlMs,
      })
      if (!acquired) throw new UnPriceBillingError({ message: "SUBSCRIPTION_BUSY" })
    }

    // heartbeat to keep the lock alive for long transitions
    const stopHeartbeat = lock
      ? (() => {
          let stopped = false
          const startedAt = Date.now()
          const renewEveryMs = Math.max(1_000, Math.floor(ttlMs / 2))
          const maxHoldMs = Math.max(ttlMs * 10, 2 * 60_000) // cap renewals to avoid indefinite locks

          const interval = setInterval(async () => {
            if (stopped) return
            const elapsed = Date.now() - startedAt
            if (elapsed > maxHoldMs) {
              this.logger.warn("subscription lock heartbeat maxHoldMs reached; stopping renew", {
                subscriptionId,
                projectId,
                ttlMs,
                maxHoldMs,
              })
              stopped = true
              clearInterval(interval)
              return
            }
            try {
              const ok = await lock.extend({ ttlMs })
              if (!ok) {
                this.logger.warn("subscription lock extend returned false; lock may be lost", {
                  subscriptionId,
                  projectId,
                })
              }
            } catch (e) {
              this.logger.error("subscription lock heartbeat extend failed", {
                error: e instanceof Error ? e.message : String(e),
                subscriptionId,
                projectId,
              })
            }
          }, renewEveryMs)

          return () => {
            stopped = true
            clearInterval(interval)
          }
        })()
      : () => {}

    const { err, val: machine } = await SubscriptionMachine.create({
      now,
      subscriptionId,
      projectId,
      logger: this.logger,
      analytics: this.analytics,
      customer: this.customerService,
      db: this.db,
    })

    if (err) {
      stopHeartbeat()
      if (lock) await lock.release()
      throw err
    }

    try {
      return await run(machine)
    } finally {
      await machine.shutdown()
      stopHeartbeat()
      if (lock) await lock.release()
    }
  }

  public async generateBillingPeriods({
    subscriptionId,
    projectId,
    now = Date.now(),
  }: {
    subscriptionId: string
    projectId: string
    now?: number
  }): Promise<Result<{ cyclesCreated: number; phasesProcessed: number }, UnPriceBillingError>> {
    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: true, // we need to lock the subscription to avoid cross-worker races
        run: async () => {
          const s1 = await this._generateBillingPeriods({
            subscriptionId,
            projectId,
            now,
          })

          if (s1.err) throw s1.err
          return s1.val
        },
      })
      return Ok({ cyclesCreated: status.cyclesCreated, phasesProcessed: status.phasesProcessed })
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  public async billingInvoice({
    projectId,
    subscriptionId,
    invoiceId,
    now = Date.now(),
  }: {
    projectId: string
    subscriptionId: string
    invoiceId: string
    now?: number
  }): Promise<
    Result<
      {
        total: number
        status: InvoiceStatus
      },
      UnPriceBillingError
    >
  > {
    try {
      const res = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: true,
        run: async (machine) => {
          const col = await this._collectInvoicePayment({
            invoiceId,
            projectId,
            now,
          })
          if (col.err) {
            await machine.reportInvoiceFailure({ invoiceId, error: col.err.message })
            throw col.err
          }
          const { totalCents, status } = col.val
          if (status === "paid" || status === "void") {
            await machine.reportInvoiceSuccess({ invoiceId })
          } else if (status === "failed") {
            await machine.reportPaymentFailure({ invoiceId, error: "Payment failed" })
          }
          return { total: totalCents, status }
        },
      })
      return Ok(res)
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  private async _collectInvoicePayment(payload: {
    invoiceId: string
    projectId: string
    now: number
  }): Promise<Result<SubscriptionInvoice, UnPriceBillingError>> {
    const { invoiceId, projectId, now } = payload

    // Get invoice details
    const invoice = await this.db.query.invoices.findFirst({
      where: (table, { eq, and }) => and(eq(table.id, invoiceId), eq(table.projectId, projectId)),
    })

    if (!invoice) {
      return Err(new UnPriceBillingError({ message: "Invoice not found" }))
    }

    const MAX_PAYMENT_ATTEMPTS = 10
    const invoicePaymentProviderId = invoice.invoicePaymentProviderId
    const paymentMethodId = invoice.paymentMethodId

    // if the invoice is draft, we can't collect the payment
    if (invoice.status === "draft") {
      return Err(
        new UnPriceBillingError({ message: "Invoice is not finalized, cannot collect payment" })
      )
    }

    // check if the invoice is already paid or void
    if (["paid", "void"].includes(invoice.status)) {
      return Ok(invoice)
    }

    // validate if the invoice is failed
    if (invoice.status === "failed") {
      // meaning the invoice is past due and we cannot collect the payment with 3 attempts
      return Err(new UnPriceBillingError({ message: "Invoice is failed, cannot collect payment" }))
    }

    // check if the invoice has an invoice id from the payment provider
    if (!invoicePaymentProviderId) {
      return Err(
        new UnPriceBillingError({
          message:
            "Invoice has no invoice id from the payment provider, please finalize the invoice first",
        })
      )
    }

    // check if the invoice has a payment method id
    // this shouldn't happen but we add a check anyway just in case
    if (!paymentMethodId || paymentMethodId === "") {
      return Err(
        new UnPriceBillingError({
          message: "Invoice requires a payment method, please set a payment method first",
        })
      )
    }

    // Get subscription data with related entities
    const subscriptionData = await this.db.query.subscriptions.findFirst({
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
      return Err(new UnPriceBillingError({ message: "Subscription not found" }))
    }

    const { phases, customer } = subscriptionData
    const phase = phases[0]

    if (!phase) {
      return Err(
        new UnPriceBillingError({
          message: "Subscription phase not found",
        })
      )
    }

    // Get payment provider config
    const config = await this.db.query.paymentProviderConfig.findFirst({
      where: (config, { and, eq }) =>
        and(
          eq(config.projectId, customer.projectId),
          eq(config.paymentProvider, invoice.paymentProvider),
          eq(config.active, true)
        ),
    })

    if (!config) {
      return Err(
        new UnPriceBillingError({
          message: "Payment provider config not found or not active",
        })
      )
    }
    const { err: paymentProviderServiceErr, val: paymentProviderService } =
      await this.customerService.getPaymentProvider({
        projectId: customer.projectId,
        provider: invoice.paymentProvider,
      })

    if (paymentProviderServiceErr) {
      return Err(new UnPriceBillingError({ message: paymentProviderServiceErr.message }))
    }

    // if the invoice is waiting, we need to check if the payment is successful
    // waiting mean we sent the invoice to the customer and we are waiting for the payment (manual payment)
    if (invoice.status === "waiting") {
      // check the status of the payment in the payment provider
      const statusPaymentProviderInvoice = await paymentProviderService.getStatusInvoice({
        invoiceId: invoicePaymentProviderId,
      })

      if (statusPaymentProviderInvoice.err) {
        return Err(new UnPriceBillingError({ message: "Error getting invoice status" }))
      }

      // if the invoice is paid or void, we update the invoice status
      if (["paid", "void"].includes(statusPaymentProviderInvoice.val.status)) {
        // update the invoice status
        const updatedInvoice = await this.db
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
          return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
        }

        return Ok(updatedInvoice)
      }

      // 3 attempts max for the invoice and the past due date is suppased
      if (
        (invoice.paymentAttempts?.length &&
          invoice.paymentAttempts.length >= MAX_PAYMENT_ATTEMPTS) ||
        (invoice.pastDueAt && invoice.pastDueAt < now)
      ) {
        // update the invoice status
        const updatedInvoice = await this.db
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
          return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
        }

        return Ok(updatedInvoice)
      }
    }

    // collect the payment depending on the collection method
    // collect automatically means we will try to collect the payment with the default payment method
    if (invoice.collectionMethod === "charge_automatically") {
      // before collecting we need to check if the invoice is already paid
      const statusInvoice = await paymentProviderService.getStatusInvoice({
        invoiceId: invoicePaymentProviderId,
      })

      if (statusInvoice.err) {
        return Err(new UnPriceBillingError({ message: "Error getting invoice status" }))
      }

      // this happen when there are many invoices and stripe merge them into one invoice
      if (["paid", "void"].includes(statusInvoice.val.status)) {
        // update the invoice status if the payment is successful
        // if not add the failed attempt
        const updatedInvoice = await this.db
          .update(invoices)
          .set({
            status: statusInvoice.val.status as InvoiceStatus,
            ...(statusInvoice.val.status === "paid" ? { paidAt: Date.now() } : {}),
            ...(statusInvoice.val.status === "paid"
              ? { invoicePaymentProviderUrl: statusInvoice.val.invoiceUrl }
              : {}),
            paymentAttempts: [
              ...(invoice.paymentAttempts ?? []),
              ...statusInvoice.val.paymentAttempts,
            ],
          })
          .where(eq(invoices.id, invoice.id))
          .returning()
          .then((res) => res[0])

        if (!updatedInvoice) {
          return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
        }

        return Ok(updatedInvoice)
      }

      const stripePaymentInvoice = await paymentProviderService.collectPayment({
        invoiceId: invoicePaymentProviderId,
        paymentMethodId: paymentMethodId,
      })

      if (stripePaymentInvoice.err) {
        // update the attempt if the payment failed
        await this.db
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
          new UnPriceBillingError({
            message: `Error collecting payment: ${stripePaymentInvoice.err.message}`,
          })
        )
      }

      const paymentStatus = stripePaymentInvoice.val.status
      const isPaid = ["paid", "void"].includes(paymentStatus)

      // update the invoice status if the payment is successful
      // if not add the failed attempt
      const updatedInvoice = await this.db
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
        return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
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
          new UnPriceBillingError({
            message: `Error sending invoice: ${stripeSendInvoice.err.message}`,
          })
        )
      }

      // update the invoice status if send invoice is successful
      const updatedInvoice = await this.db
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
        return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
      }

      return Ok(updatedInvoice)
    }

    return Err(new UnPriceBillingError({ message: "Unsupported status for invoice" }))
  }

  public async finalizeInvoice({
    projectId,
    subscriptionId,
    invoiceId,
    now = Date.now(),
  }: {
    projectId: string
    subscriptionId: string
    invoiceId: string
    now?: number
  }): Promise<
    Result<
      {
        providerInvoiceId?: string
        providerInvoiceUrl?: string
        invoiceId: string
        status: InvoiceStatus
      },
      UnPriceBillingError
    >
  > {
    try {
      const res = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: false, // no need to lock it here
        run: async (machine) => {
          const fin = await this._finalizeInvoice({
            subscriptionId,
            projectId,
            now,
            invoiceId,
          })

          if (fin.err) {
            throw fin.err
          }

          const providerInvoiceData = await this._upsertPaymentProviderInvoice({
            invoiceId: fin.val.id,
            projectId,
          })

          if (providerInvoiceData.err) {
            // report failed invoice
            await machine.reportInvoiceFailure({
              invoiceId: fin.val.id,
              error: providerInvoiceData.err.message,
            })
            throw providerInvoiceData.err
          }

          // report successful invoice
          await machine.reportInvoiceSuccess({ invoiceId: fin.val.id })

          return {
            providerInvoiceId: providerInvoiceData.val.providerInvoiceId,
            providerInvoiceUrl: providerInvoiceData.val.providerInvoiceUrl,
            invoiceId: fin.val.id,
            status: fin.val.status,
          }
        },
      })

      return Ok(res)
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  private async getOpenInvoiceData({
    subscriptionId,
    projectId,
    invoiceId,
    now,
  }: {
    subscriptionId: string
    projectId: string
    invoiceId: string
    now: number
  }): Promise<
    Result<
      SubscriptionInvoice & { invoiceItems: InvoiceItemExtended[]; customer: Customer },
      UnPriceBillingError
    >
  > {
    try {
      const invoice = await this.db.query.invoices.findFirst({
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
        where: (inv, { and, eq, inArray, lte, or, isNull }) =>
          or(
            // for invoices that have not been finilized yet
            and(
              eq(inv.projectId, projectId),
              eq(inv.id, invoiceId),
              eq(inv.subscriptionId, subscriptionId),
              eq(inv.status, "draft"),
              lte(inv.dueAt, now)
            ),
            // for invoices that have been finilized but not sent to the payment provider
            and(
              eq(inv.projectId, projectId),
              eq(inv.id, invoiceId),
              eq(inv.subscriptionId, subscriptionId),
              inArray(inv.status, ["unpaid", "waiting"]),
              isNull(inv.invoicePaymentProviderId),
              lte(inv.dueAt, now)
            )
          ),
        orderBy: (inv, { asc }) => asc(inv.dueAt),
      })

      if (!invoice) {
        return Err(
          new UnPriceBillingError({ message: "Invoice not found or not due to be processed" })
        )
      }

      return Ok(invoice)
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  // only compute/persist amounts, apply credits, create/update/finalize the provider invoice.
  private async _finalizeInvoice({
    subscriptionId,
    projectId,
    now,
    invoiceId,
  }: {
    subscriptionId: string
    projectId: string
    now: number
    invoiceId: string
  }): Promise<Result<SubscriptionInvoice, UnPriceBillingError>> {
    const { err: openInvoiceDataErr, val: openInvoiceData } = await this.getOpenInvoiceData({
      subscriptionId,
      projectId,
      now,
      invoiceId,
    })

    if (openInvoiceDataErr) {
      return Err(openInvoiceDataErr)
    }

    // if invoice already processed, skip it
    if (openInvoiceData.invoicePaymentProviderId || openInvoiceData.status !== "draft") {
      return Ok(openInvoiceData)
    }

    // only kind period or trial are supported
    // for getting the quantity and price
    // TODO: we need to handle the other cases as well (credit and discount)
    const invoiceItemsToUpdate = openInvoiceData.invoiceItems
      .filter((item) => item.featurePlanVersionId !== null)
      .filter((item) => item.subscriptionItemId !== null)
      .filter((item) => item.kind === "period" || item.kind === "trial")

    if (invoiceItemsToUpdate.length === 0) {
      return Ok(openInvoiceData)
    }

    // compute the invoice items for getting the right quantities and prices
    const { val: billableItems, err: billableItemsErr } = await this._computeInvoiceItems({
      invoice: openInvoiceData,
      items: invoiceItemsToUpdate as InvoiceItemExtended[],
    })

    if (billableItemsErr) {
      this.logger.error("Error computing invoice items", {
        statementKey: openInvoiceData.statementKey,
        subscriptionId: openInvoiceData.subscriptionId,
        projectId: openInvoiceData.projectId,
        customerId: openInvoiceData.customerId,
      })

      return Err(new UnPriceBillingError({ message: billableItemsErr.message }))
    }

    // all this happends in a transaction
    const result = await this.db.transaction(async (tx) => {
      try {
        const billableItemsIds = billableItems.items.map((item) => item.id)

        // we update in a single query
        const quantityChunks = []
        const totalAmountChunks = []
        const unitAmountChunks = []
        const subtotalAmountChunks = []
        const descriptionChunks = []

        if (billableItems.items.length > 0) {
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
            descriptionChunks.push(
              sql`when ${invoiceItems.id} = ${item.id} then ${item.description}`
            )
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
          // one single query for updating the invoice items
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
                eq(invoiceItems.invoiceId, openInvoiceData.id),
                eq(invoiceItems.projectId, projectId),
                inArray(invoiceItems.id, billableItemsIds)
              )
            )
        }

        // get the subtotal amount
        const subtotalAmount = billableItems.items.reduce((a, i) => a + i.subtotalAmount, 0)
        const totalAmount = billableItems.items.reduce((a, i) => a + i.totalAmount, 0)

        // apply credits if any
        const { err: applyCreditsErr, val: applyCreditsResult } = await this._applyCredits({
          db: tx, // execute in the same transaction
          invoice: { ...openInvoiceData, subtotalCents: subtotalAmount, totalCents: totalAmount },
          now,
        })

        if (applyCreditsErr) {
          this.logger.error("Error applying credits", {
            invoiceId: openInvoiceData.id,
            projectId: openInvoiceData.projectId,
          })

          // we throw an error to rollback the transaction
          throw applyCreditsErr
        }

        const finalTotalAmount = applyCreditsResult.remainingInvoiceTotal
        const finalSubtotalAmount = subtotalAmount - applyCreditsResult.applied

        // void the billing period if the total amount is 0 or proration factor is 0
        const statusInvoice = totalAmount === 0 ? ("void" as const) : ("unpaid" as const)

        // update the invoice
        const updatedInvoice = await tx
          .update(invoices)
          .set({
            subtotalCents: finalSubtotalAmount,
            totalCents: finalTotalAmount,
            status: statusInvoice,
            issueDate: now,
            metadata: {
              ...(openInvoiceData.metadata ?? {}),
              // TODO: change who is finalizing the invoice
              note: "Finilized by scheduler",
            },
          })
          .where(
            and(
              eq(invoices.id, openInvoiceData.id),
              eq(invoices.projectId, projectId),
              eq(invoices.subscriptionId, subscriptionId)
            )
          )
          .returning()
          .then((res) => res[0])

        if (!updatedInvoice) {
          throw new Error("Error updating invoice")
        }

        return updatedInvoice
      } catch (error) {
        this.logger.error("Error finalizing invoice", {
          invoiceId: openInvoiceData.id,
          projectId: openInvoiceData.projectId,
          error: error instanceof Error ? error.message : "unknown error",
        })
        tx.rollback()
        throw error
      }
    })

    return Ok(result)
  }

  private async _computeInvoiceItems(payload: {
    invoice: SubscriptionInvoice
    items: InvoiceItemExtended[]
  }): Promise<
    Result<
      {
        items: ComputeInvoiceItemsResult[]
      },
      UnPriceBillingError
    >
  > {
    const { invoice, items } = payload

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
      // 1. Fetch all active grants for this customer at the given time
      const { val: allGrants, err: grantsErr } = await this.grantsManager.getGrantsForCustomer({
        customerId: invoice.customerId,
        projectId: invoice.projectId,
        now: invoice.dueAt, // we need the grants at the time of the invoice
      })

      if (grantsErr) {
        return Err(new UnPriceBillingError({ message: grantsErr.message }))
      }

      // Group grants by feature slug
      const grantsByFeature = new Map<string, typeof allGrants.grants>()
      for (const grant of allGrants.grants) {
        const slug = grant.featurePlanVersion.feature.slug
        if (!grantsByFeature.has(slug)) {
          grantsByFeature.set(slug, [])
        }
        grantsByFeature.get(slug)!.push(grant)
      }

      for (const cycleKey of Object.keys(cycleGroups)) {
        const [cycleStartAt, cycleEndAt] = cycleKey.split("-").map(Number) as [number, number]
        const cycleGroup = cycleGroups[cycleKey]!

        // Process usage features
        // We need to group invoice items by feature to handle multiple items for same feature
        const itemsByFeature = new Map<string, InvoiceItemExtended[]>()
        const nonUsageItems: InvoiceItemExtended[] = []

        for (const item of cycleGroup) {
          if (item.subscriptionItemId && item.featurePlanVersion!.featureType === "usage") {
            const slug = item.featurePlanVersion!.feature.slug
            if (!itemsByFeature.has(slug)) {
              itemsByFeature.set(slug, [])
            }
            itemsByFeature.get(slug)!.push(item)
          } else {
            nonUsageItems.push(item)
          }
        }

        // Batch fetch usage data for all usage features in this cycle
        const usageFeaturesToFetch: Array<{
          featureSlug: string
          aggregationMethod: AggregationMethod
          featureType: FeatureType
        }> = []

        const featureMetadata = new Map<
          string,
          {
            grants: typeof allGrants.grants
            items: InvoiceItemExtended[]
            entitlement: Omit<Entitlement, "id">
          }
        >()

        // Pre-compute entitlement states for all usage features to get aggregation methods
        for (const [featureSlug, featureItems] of itemsByFeature.entries()) {
          const featureGrants = grantsByFeature.get(featureSlug) ?? []

          // Compute entitlement state to get aggregation method
          const computedStateResult = await this.grantsManager.computeEntitlementState({
            grants: featureGrants,
            customerId: invoice.customerId,
            projectId: invoice.projectId,
          })

          if (computedStateResult.err) {
            this.logger.error("Failed to compute entitlement state for feature", {
              featureSlug,
              error: computedStateResult.err.message,
            })
            continue
          }

          const entitlement = computedStateResult.val

          featureMetadata.set(featureSlug, {
            grants: featureGrants,
            items: featureItems,
            entitlement,
          })

          if (entitlement.featureType === "usage") {
            usageFeaturesToFetch.push({
              featureSlug,
              aggregationMethod: entitlement.aggregationMethod,
              featureType: entitlement.featureType,
            })
          }
        }

        // Batch fetch usage data for all usage features in this cycle
        let batchUsageData: { featureSlug: string; usage: number }[] | undefined

        if (usageFeaturesToFetch.length > 0) {
          const { err: usageErr, val: fetchedUsageData } =
            await this.analytics.getUsageBillingFeatures({
              customerId: invoice.customerId,
              projectId: invoice.projectId,
              features: usageFeaturesToFetch,
              startAt: cycleStartAt,
              endAt: cycleEndAt,
            })

          if (usageErr) {
            this.logger.error("Failed to batch fetch usage data for cycle", {
              error: usageErr.message,
              cycleKey,
            })
            return Err(new UnPriceBillingError({ message: usageErr.message }))
          }

          batchUsageData = fetchedUsageData
        }

        // Process usage items using calculateFeaturePrice
        for (const [featureSlug, metadata] of featureMetadata.entries()) {
          const featureGrants = metadata.grants
          const featureItems = metadata.items

          // Resolver to map grantId to subscriptionItemId
          const subscriptionItemIdResolver = (grantId: string) => {
            // Check if any of the feature items match this grant
            const grant = featureGrants.find((g) => g.id === grantId)
            // Try to match based on direct link or feature version
            // If grant has subscriptionItem populated, good.
            // But we fetched grants with getGrantsForCustomer which uses grantSchemaExtended.
            // The items have subscriptionItemId.

            // If the grant corresponds to a subscription item in our invoice items list, return that ID.
            if (grant?.subscriptionItem?.id) return grant.subscriptionItem.id

            // Fallback: match by feature plan version id?
            // If there's an invoice item with same feature plan version, use its subscriptionItemId
            // But what if multiple items?
            // Generally unique per feature plan version in a subscription phase.
            const matchingItem = featureItems.find(
              (i) => i.featurePlanVersionId === grant?.featurePlanVersionId
            )
            return matchingItem?.subscriptionItemId ?? undefined
          }

          const calcResult = await this.calculateFeaturePrice({
            projectId: invoice.projectId,
            customerId: invoice.customerId,
            featureSlug,
            grants: featureGrants,
            startAt: cycleStartAt,
            endAt: cycleEndAt,
            usageData: batchUsageData, // Pass pre-fetched usage data
          })

          if (calcResult.err) {
            this.logger.error("Error calculating feature price", {
              featureSlug,
              error: calcResult.err.message,
            })
            // Continue with other features? Or fail invoice?
            // Existing logic failed the invoice on error.
            return Err(new UnPriceBillingError({ message: calcResult.err.message }))
          }

          // Map results back to updatedItems
          const itemBySubId = new Map<string, InvoiceItemExtended>()
          for (const item of featureItems) {
            if (item.subscriptionItemId) {
              itemBySubId.set(item.subscriptionItemId, item)
            }
          }

          if (calcResult.val.length === 0) {
            // If no calculation result (e.g. no grants), ensure we zero out the items
            // instead of dropping them, which would cause invoice total mismatch
            for (const item of featureItems) {
              updatedItems.push({
                id: item.id,
                totalAmount: 0,
                unitAmount: 0,
                subtotalAmount: 0,
                prorate: item.prorationFactor ?? 1,
                description: item.description
                  ? item.description.toUpperCase()
                  : item.featurePlanVersion!.feature.title.toUpperCase(),
                cycleStartAt: cycleStartAt,
                cycleEndAt: cycleEndAt,
                quantity: 0,
              })
            }
          } else {
            for (const res of calcResult.val) {
              let targetItem: InvoiceItemExtended | undefined

              // If we have a grantId, try to find the subscription item
              if (res.grantId) {
                // We rely on calculateFeaturePrice resolving the subscriptionItemId
                // Or we resolve it again?
                // calculateFeaturePrice uses resolver to fetch usage.
                // result doesn't have subscriptionItemId.
                // We need to map grantId -> subscriptionItemId again.
                const subId = subscriptionItemIdResolver(res.grantId)
                if (subId) {
                  targetItem = itemBySubId.get(subId)
                }
              } else {
                // Overage: default to first item
                targetItem = featureItems[0]
              }

              if (targetItem) {
                const unitAmountCents = formatAmountDinero(res.price.unitPrice.dinero).amount
                const totalAmountCents = formatAmountDinero(res.price.totalPrice.dinero).amount
                const subtotalAmountCents = formatAmountDinero(
                  res.price.subtotalPrice.dinero
                ).amount

                let description = targetItem.description ?? ""
                let descriptionDetail = ""

                if (res.prorate !== 1) {
                  const endAt = Number.isFinite(res.cycleEndAt) ? res.cycleEndAt : cycleEndAt // fallback if somehow invalid

                  const billingPeriod = `${new Date(res.cycleStartAt).toISOString().split("T")[0]} to ${
                    new Date(endAt).toISOString().split("T")[0]
                  }`

                  descriptionDetail += res.isTrial
                    ? ` trial (${billingPeriod})`
                    : ` prorated (${billingPeriod})`
                }

                // Switch description logic
                switch (targetItem.featurePlanVersion!.featureType) {
                  case "usage":
                    description = `${targetItem.featurePlanVersion!.feature.title.toUpperCase()} - tier usage ${descriptionDetail}`
                    break
                  case "flat":
                    description = `${targetItem.featurePlanVersion!.feature.title.toUpperCase()} - flat ${descriptionDetail}`
                    break
                  case "package":
                    description = `${targetItem.featurePlanVersion!.feature.title.toUpperCase()} - package ${descriptionDetail}`
                    break
                  default:
                    description = targetItem.featurePlanVersion!.feature.title.toUpperCase()
                }

                updatedItems.push({
                  id: targetItem.id,
                  totalAmount: totalAmountCents,
                  unitAmount: unitAmountCents,
                  subtotalAmount: subtotalAmountCents,
                  prorate: res.prorate,
                  description,
                  cycleStartAt: res.cycleStartAt,
                  cycleEndAt: res.cycleEndAt,
                  quantity: res.usage,
                })
              }
            }
          }
        }

        // Process non-usage items (flat, package, tier with no usage?)
        // Same logic as before
        for (const item of nonUsageItems) {
          // ... existing logic for non-usage items ...
          // Copy from previous implementation
          let quantity = item.quantity
          let totalAmount = 0
          let unitAmount = 0
          let subtotalAmount = 0

          const isTrial = item.kind === "trial"

          const { val: priceCalculation, err: priceCalculationErr } = calculatePricePerFeature({
            config: item.featurePlanVersion!.config,
            featureType: item.featurePlanVersion!.featureType,
            quantity: quantity,
            prorate: item.prorationFactor,
          })

          if (priceCalculationErr) {
            return Err(new UnPriceBillingError({ message: priceCalculationErr.message }))
          }

          const formattedTotalAmount = formatAmountDinero(priceCalculation.totalPrice.dinero)
          const formattedUnitAmount = formatAmountDinero(priceCalculation.unitPrice.dinero)
          const formattedSubtotalAmount = formatAmountDinero(priceCalculation.subtotalPrice.dinero)

          unitAmount = formattedUnitAmount.amount
          subtotalAmount = formattedSubtotalAmount.amount
          totalAmount = isTrial ? 0 : formattedTotalAmount.amount

          let description = ""
          let descriptionDetail = ""

          if (item.prorationFactor !== 1) {
            // cycleEndAt in invoice items is bigint, should be finite number, but checking just in case
            const endAt = Number.isFinite(item.cycleEndAt) ? item.cycleEndAt : new Date().getTime() // fallback if somehow invalid

            const billingPeriod = `${new Date(item.cycleStartAt).toISOString().split("T")[0]} to ${
              new Date(endAt).toISOString().split("T")[0]
            }`

            descriptionDetail +=
              item.kind === "trial" ? ` trial (${billingPeriod})` : ` prorated (${billingPeriod})`
          }

          // Switch description logic
          switch (item.featurePlanVersion!.featureType) {
            case "flat":
              description = `${item.featurePlanVersion!.feature.title.toUpperCase()} - flat ${descriptionDetail}`
              break
            case "package": {
              const quantityPackages = Math.ceil(quantity / item.featurePlanVersion!.config?.units!)
              quantity = quantityPackages
              description = `${item.featurePlanVersion!.feature.title.toUpperCase()} - ${quantityPackages} package of ${item.featurePlanVersion!.config?.units!} units ${descriptionDetail}`
              break
            }
            default:
              description = item.featurePlanVersion!.feature.title.toUpperCase()
          }

          updatedItems.push({
            id: item.id,
            totalAmount,
            unitAmount,
            subtotalAmount,
            prorate: item.prorationFactor,
            description,
            cycleStartAt: item.cycleStartAt,
            cycleEndAt: item.cycleEndAt,
            quantity,
          })
        }
      }

      return Ok({
        items: updatedItems,
      })
    } catch (e) {
      const error = e as Error
      this.logger.error("Error calculating invoice items price", {
        error: error.message,
      })
      return Err(new UnPriceBillingError({ message: `Unhandled error: ${error.message}` }))
    }
  }

  private async _upsertPaymentProviderInvoice(opts: {
    invoiceId: string
    projectId: string
  }): Promise<
    Result<
      { providerInvoiceId?: string; providerInvoiceUrl?: string },
      UnPriceBillingError | FetchError
    >
  > {
    const { default: pLimit } = await import("p-limit")

    const invoice = await this.db.query.invoices.findFirst({
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
      where: (table, { eq, and }) =>
        and(eq(table.id, opts.invoiceId), eq(table.projectId, opts.projectId)),
    })

    if (!invoice) {
      return Err(new UnPriceBillingError({ message: "Invoice not found" }))
    }

    if (["draft"].includes(invoice.status)) {
      return Err(new UnPriceBillingError({ message: "Invoice is not ready to process" }))
    }

    if (invoice.status === "void" || invoice.totalCents === 0) {
      return Ok({
        providerInvoiceId: "",
        providerInvoiceUrl: "",
      })
    }

    // if already processed
    if (invoice.invoicePaymentProviderId) {
      return Ok({
        providerInvoiceId: invoice.invoicePaymentProviderId,
        providerInvoiceUrl: invoice.invoicePaymentProviderUrl ?? "",
      })
    }

    const description = `Invoice ${invoice.statementDateString}`
    const customFields = [
      { name: "Billing Period", value: invoice.statementDateString },
      { name: "statementKey", value: invoice.statementKey },
    ]
    const basePayload = {
      currency: invoice.currency,
      collectionMethod: invoice.collectionMethod,
      customerName: invoice.customer.name,
      email: invoice.customer.email,
      description,
      dueDate: invoice.dueAt ?? undefined,
      customFields,
    } as const

    let providerInvoiceId = invoice.invoicePaymentProviderId ?? ""
    let providerInvoiceUrl = invoice.invoicePaymentProviderUrl ?? ""

    const { val: paymentProviderService, err: paymentProviderErr } =
      await this.customerService.getPaymentProvider({
        customerId: invoice.customer.id,
        projectId: invoice.projectId,
        provider: invoice.paymentProvider,
      })

    if (paymentProviderErr) {
      return Err(
        new UnPriceBillingError({
          message: `getPaymentProvider failed: ${paymentProviderErr.message}`,
        })
      )
    }

    // upsert provider invoice
    if (!providerInvoiceId) {
      const created = await paymentProviderService.createInvoice(basePayload)

      if (created.err) {
        return Err(
          new UnPriceBillingError({ message: `createInvoice failed: ${created.err.message}` })
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
          new UnPriceBillingError({ message: `updateInvoice failed: ${updated.err.message}` })
        )
      }

      providerInvoiceUrl = updated.val?.invoiceUrl ?? ""
    }

    // Reconcile items by subscriptionItemId metadata
    const current = await paymentProviderService.getInvoice({ invoiceId: providerInvoiceId })

    if (current.err) {
      return Err(new UnPriceBillingError({ message: `getInvoice failed: ${current.err.message}` }))
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

    for (const item of invoice.invoiceItems) {
      // all items should have a feature plan version
      // TODO: how to handle credits and discounts?
      if (!item.featurePlanVersion) continue

      // if the total amount and subtotal amount are 0 we skip the creation of the invoice item
      if (item.amountTotal === 0 && item.amountSubtotal === 0) continue
      const subId = item.subscriptionItemId ?? ""
      const isProrated = (item.prorationFactor ?? 1) !== 1
      // get the existing invoice item id by subscription item id
      const existingId = subId ? bySubId.get(subId) : undefined

      const period = {
        start: Math.floor(item.cycleStartAt / 1000),
        end: Math.floor(item.cycleEndAt / 1000),
      }

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
              period,
            })
            if (res.err) throw new Error(`updateInvoiceItem failed: ${res.err.message}`)
          })
        )
      } else {
        tasks.push(
          limit(async () => {
            const res = await paymentProviderService.addInvoiceItem({
              invoiceId: providerInvoiceId,
              name: item.featurePlanVersion!.feature.slug,
              // TODO: there is an edge case where if the feature is tier based with flat charges
              // the flat charge is combined with the tier charge and the total amount is not correct
              // we need to add a separate line item for the flat charge
              description: item.description ?? "",
              isProrated,
              totalAmount: item.amountTotal,
              unitAmount: item.unitAmountCents ?? undefined, // ignored in amount-path by provider
              quantity: item.quantity,
              currency: invoice.currency,
              metadata: subId ? { subscriptionItemId: subId } : undefined,
              period,
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
      invoice.totalCents &&
      invoice.totalCents > 0
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
      this.logger.error("Provider item upsert failed", {
        error: error.message,
        invoiceId: invoice.id,
      })
      return Err(new UnPriceBillingError({ message: error.message }))
    }

    // Re-fetch to validate totals and capture item IDs for persistence
    const { err: verifyErr, val: invoiceFromProvider } = await paymentProviderService.getInvoice({
      invoiceId: providerInvoiceId,
    })

    if (verifyErr) {
      return Err(
        new UnPriceBillingError({
          message: `getInvoice verification failed: ${verifyErr.message}`,
        })
      )
    }

    if (invoiceFromProvider.total !== invoice.totalCents) {
      this.logger.error("Provider invoice total mismatch", {
        invoiceId: invoice.id,
        providerInvoiceId,
        internalTotal: invoice.totalCents,
        providerTotal: invoiceFromProvider.total,
      })

      // before returning we need to save the invoice from the provider to debug
      // the newly created invoice from the provider remains as draft to be able to debug if necessary
      // next iteration we will try to finalize the invoice again
      await this.db.transaction(async (tx) => {
        await tx
          .update(invoices)
          .set({
            status: "draft", // we need to set the status to draft to be able to debug
            metadata: {
              ...(invoice.metadata ?? {}),
              reason: "invoice_failed",
              note: "Failed to finalize invoice due to provider invoice total mismatch",
            },
          })
          .where(and(eq(invoices.id, invoice.id), eq(invoices.projectId, invoice.projectId)))
      })

      return Err(
        new UnPriceBillingError({
          message: `Provider total does not match internal total: ${invoice.totalCents} !== ${invoiceFromProvider.total}`,
        })
      )
    }

    // finilize the invoice only if status is !"open," "paid," "uncollectible," or "void."
    if (!["open", "paid", "uncollectible", "void"].includes(invoiceFromProvider.status ?? "")) {
      // Finalize provider invoice (no send/charge here)
      const fin = await paymentProviderService.finalizeInvoice({ invoiceId: providerInvoiceId })
      if (fin.err) {
        return Err(
          new UnPriceBillingError({ message: `finalizeInvoice failed: ${fin.err.message}` })
        )
      }
    }

    // Persist provider ids and item provider ids using the last snapshot (no remote calls in tx)
    const providerItemBySub = new Map<string, string>()
    for (const it of invoiceFromProvider.items) {
      const subId = it.metadata?.subscriptionItemId
      if (subId) providerItemBySub.set(subId, it.id)
    }

    // Persist provider ids in a short tx
    await this.db.transaction(async (tx) => {
      await tx
        .update(invoices)
        .set({
          invoicePaymentProviderId: providerInvoiceId,
          invoicePaymentProviderUrl: providerInvoiceUrl,
          metadata: {
            ...(invoice.metadata ?? {}),
            note: "Invoice finalized successfully",
          },
        })
        .where(and(eq(invoices.id, invoice.id), eq(invoices.projectId, invoice.projectId)))

      for (const item of invoice.invoiceItems) {
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
  private async _applyCredits(input: {
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
      UnPriceBillingError | FetchError
    >
  > {
    const { db, invoice, now } = input

    return db.transaction(async (tx) => {
      const { projectId, customerId, id: invoiceId, currency, paymentProvider } = invoice

      // Nothing to apply if already zero or void/paid
      const currentTotalBeforeCredits = invoice.totalCents ?? 0
      if (currentTotalBeforeCredits <= 0 || ["void", "paid"].includes(invoice.status)) {
        return Ok({
          applied: 0,
          remainingInvoiceTotal: currentTotalBeforeCredits,
          applications: [],
        })
      }

      // Already-applied credits for this invoice (idempotency)
      const existingApps = await tx.query.invoiceCreditApplications.findMany({
        where: (a, { and, eq }) => and(eq(a.projectId, projectId), eq(a.invoiceId, invoiceId)),
      })
      const alreadyApplied = existingApps.reduce((sum, a) => sum + a.amountApplied, 0)

      // Eligible credit grants (active, not expired, with available > 0)
      const grants = await tx.query.creditGrants.findMany({
        where: (g, { and, eq, or, isNull, gt }) =>
          and(
            eq(g.projectId, projectId),
            eq(g.customerId, customerId),
            eq(g.currency, currency),
            eq(g.paymentProvider, paymentProvider),
            eq(g.active, true),
            or(isNull(g.expiresAt), gt(g.expiresAt, now))
          ),
        orderBy: (g, { asc }) => asc(g.expiresAt), // FIFO by earliest expiry
      })

      let remaining = Math.max(0, currentTotalBeforeCredits - alreadyApplied)
      let applied = 0
      const applications: { grantId: string; amount: number }[] = []

      for (const grant of grants) {
        if (remaining <= 0) break
        const available = Math.max(0, grant.totalAmount - grant.amountUsed)
        const toApply = Math.min(available, remaining)
        if (toApply <= 0) continue

        // Record application (per-invoice idempotency is protected by 'remaining')
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

      const newAmountCreditUsed = alreadyApplied + applied
      const newTotal = Math.max(0, (invoice.subtotalCents ?? 0) - newAmountCreditUsed)

      // Persist only if anything changed or if idempotent recompute
      await tx
        .update(invoices)
        .set({
          amountCreditUsed: newAmountCreditUsed,
          totalCents: newTotal,
          metadata: { ...(invoice.metadata ?? {}), credits: "Credits applied" },
        })
        .where(and(eq(invoices.id, invoice.id), eq(invoices.projectId, projectId)))

      return Ok({ applied, remainingInvoiceTotal: newTotal, applications })
    })
  }

  // this will materialize all the pending billing periods for the current phase or ended phases in the last N days
  // the idea is to keep a record of every billing cycle for the subscription
  // this way we can rely on these records to finalize and bill the invoices
  private async _generateBillingPeriods({
    subscriptionId,
    projectId,
    now,
  }: {
    subscriptionId: string
    projectId: string
    now: number
  }): Promise<
    Result<
      {
        phasesProcessed: number
        cyclesCreated: number
      },
      UnPriceBillingError
    >
  > {
    const lookbackDays = 7 // lookback days to materialize pending periods
    const batch = 100 // process a max of 100 phases per trigger run

    // fetch phases that are active now OR ended recently
    const phases = await this.db.query.subscriptionPhases.findMany({
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
          ops.eq(phase.projectId, projectId),
          ops.eq(phase.subscriptionId, subscriptionId),
          ops.lte(phase.startAt, now),
          ops.or(
            ops.isNull(phase.endAt),
            ops.gte(phase.endAt, addDays(now, -lookbackDays).getTime())
          )
        ),
      limit: batch, // limit to batch size to avoid overwhelming the system
    })

    this.logger.info(`Materializing billing periods for ${phases.length} phases`)

    let cyclesCreated = 0

    // for each phase, materialize the pending periods
    // TODO: reduce complexity
    for (const phase of phases) {
      // For every subscription item, backfill missing billing periods idempotently
      for (const item of phase.items) {
        // Find the last period for this item to make per-item backfill
        const lastForItem = await this.db.query.billingPeriods.findFirst({
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
        const itemBillingConfig = item.featurePlanVersion.billingConfig

        const windows = calculateNextNCycles({
          referenceDate: now, // we use the now to start the calculation
          effectiveStartDate: cursorStart,
          trialEndsAt: phase.trialEndsAt,
          effectiveEndDate: phase.endAt,
          config: {
            name: itemBillingConfig.name,
            interval: itemBillingConfig.billingInterval,
            intervalCount: itemBillingConfig.billingIntervalCount,
            planType: itemBillingConfig.planType,
            anchor: phase.billingAnchor,
          },
          count: 0, // we only need until the end of the current cycle
        })

        if (windows.length === 0) continue

        // all happens in a single transaction
        await this.db.transaction(async (tx) => {
          try {
            // Insert periods idempotently with unique index protection
            const values = await Promise.all(
              windows.map(async (w) => {
                const whenToBill = phase.planVersion.whenToBill
                // handles when to invoice; this way pay in advance aligns with the cycle start
                // and pay in arrear aligns with the cycle end
                const invoiceAt = whenToBill === "pay_in_advance" ? w.start : w.end
                const statementKey = await this.computeStatementKey({
                  projectId: phase.projectId,
                  customerId: phase.subscription.customerId,
                  subscriptionId: phase.subscriptionId,
                  invoiceAt: invoiceAt,
                  currency: phase.planVersion.currency,
                  paymentProvider: phase.planVersion.paymentProvider,
                  collectionMethod: phase.planVersion.collectionMethod,
                })

                let grantId = ""

                // Check if there is an active grant for this feature/subscription item
                // preventing duplicate/exploding grants if one is already open-ended or covers the period
                // TODO: reduce queries here
                const existingGrant = await tx.query.grants.findFirst({
                  where: (g, { and, eq, or, isNull, lte, gte }) =>
                    and(
                      eq(g.projectId, phase.projectId),
                      eq(g.subjectType, "customer"),
                      eq(g.subjectId, phase.subscription.customerId),
                      eq(g.featurePlanVersionId, item.featurePlanVersion.id),
                      eq(g.type, w.isTrial ? "trial" : "subscription"),
                      eq(g.deleted, false),
                      lte(g.effectiveAt, phase.startAt),
                      or(
                        isNull(g.expiresAt),
                        // if trial we check if the grant expires at the trial end, otherwise we check if the grant expires at the end of the phase
                        w.isTrial && phase.trialEndsAt
                          ? gte(g.expiresAt, phase.trialEndsAt)
                          : phase.endAt
                            ? gte(g.expiresAt, phase.endAt)
                            : undefined
                      )
                    ),
                  orderBy: (g, { desc }) => desc(g.effectiveAt),
                })

                if (existingGrant) {
                  grantId = existingGrant.id
                } else {
                  // first we need to create the grant for the billing period
                  // use a scoped grants manager to ensure transactional integrity
                  const txGrantsManager = new GrantsManager({
                    db: tx,
                    logger: this.logger,
                  })

                  const createGrantResult = await txGrantsManager.createGrant({
                    grant: {
                      id: newId("grant"),
                      name: "Base Plan",
                      projectId: phase.projectId,
                      effectiveAt: phase.startAt,
                      // if trial, the grant expires at the trial end
                      // if not trial, the grant expires at the end of the phase
                      expiresAt: w.isTrial ? phase.trialEndsAt : phase.endAt,
                      type: w.isTrial ? "trial" : "subscription",
                      subjectType: "customer",
                      subjectId: phase.subscription.customerId,
                      featurePlanVersionId: item.featurePlanVersion.id,
                      autoRenew: false, // we don't auto renew subscriptions grants, they are open ended
                      limit: item.units ?? item.featurePlanVersion.limit ?? null,
                      allowOverage: item.featurePlanVersion.allowOverage,
                      units: item.units,
                      anchor: phase.billingAnchor,
                      metadata: {
                        note: "Billing period grant created by billing service",
                      },
                    },
                  })

                  if (createGrantResult.err) {
                    this.logger.error("Failed to create grant", {
                      error: createGrantResult.err.message,
                    })
                    throw createGrantResult.err
                  }
                  grantId = createGrantResult.val.id
                }

                // create the billing period
                await tx
                  .insert(billingPeriods)
                  .values({
                    id: newId("billing_period"),
                    projectId: phase.projectId,
                    subscriptionId: phase.subscriptionId,
                    customerId: phase.subscription.customerId,
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
                    reason: w.isTrial ? ("trial" as const) : ("normal" as const),
                    grantId: grantId,
                  })
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
                  .catch((error) => {
                    this.logger.error("Error creating billing period", {
                      error: error instanceof Error ? error.message : String(error),
                      billingPeriodId: newId("billing_period"),
                    })
                    throw error
                  })
              })
            )

            cyclesCreated += values.length
          } catch (e) {
            this.logger.warn("Skipping existing billing periods (likely conflict)", {
              phaseId: phase.id,
              subscriptionId: phase.subscriptionId,
              projectId: phase.projectId,
              error: (e as Error)?.message,
            })
            throw e
          }
        })
      }
    }

    return Ok({
      phasesProcessed: phases.length,
      cyclesCreated: cyclesCreated,
    })
  }

  /**
   * Calculates the billing window based on entitlement state and time parameters.
   * Handles both 'now' and explicit startAt/endAt scenarios.
   */
  private calculateBillingWindow({
    entitlement,
    now,
    startAt,
    endAt,
  }: {
    entitlement: Omit<Entitlement, "id">
    now?: number
    startAt?: number
    endAt?: number
  }): Result<{ billingStartAt: number; billingEndAt: number }, UnPriceBillingError> {
    const resetConfig = entitlement.resetConfig

    // If explicit dates provided, use them
    if (startAt !== undefined && endAt !== undefined) {
      if (startAt >= endAt) {
        return Err(
          new UnPriceBillingError({
            message: `Invalid billing window: startAt (${startAt}) must be before endAt (${endAt})`,
          })
        )
      }
      return Ok({ billingStartAt: startAt, billingEndAt: endAt })
    }

    // Calculate from 'now' if provided
    if (now !== undefined) {
      if (resetConfig) {
        const cycleWindow = calculateCycleWindow({
          now,
          effectiveStartDate: entitlement.effectiveAt,
          effectiveEndDate: entitlement.expiresAt,
          config: {
            name: resetConfig.name,
            interval: resetConfig.resetInterval,
            intervalCount: resetConfig.resetIntervalCount,
            planType: resetConfig.planType,
            anchor: resetConfig.resetAnchor,
          },
          trialEndsAt: null,
        })

        if (cycleWindow) {
          return Ok({
            billingStartAt: cycleWindow.start,
            billingEndAt: cycleWindow.end,
          })
        }
      }

      // Fallback: use grant effective dates
      const billingStartAt = entitlement.effectiveAt
      // max int64 that represent the max date
      const billingEndAt = entitlement.expiresAt ?? new Date("9999-12-31").getTime()

      if (billingStartAt >= billingEndAt) {
        return Err(
          new UnPriceBillingError({
            message: `Invalid billing window: startAt (${billingStartAt}) must be before endAt (${billingEndAt})`,
          })
        )
      }

      return Ok({ billingStartAt, billingEndAt })
    }

    return Err(
      new UnPriceBillingError({
        message: "Either 'now' or both 'startAt' and 'endAt' must be provided",
      })
    )
  }

  /**
   * Calculates usage data for features based on grants, entitlement state, and billing window.
   * This method handles fetching usage data (if not provided) and computing total usage amounts.
   * Can be reused across calculateFeaturePrice and estimatePriceCurrentUsage.
   *
   * @returns Object containing usage information including usage, and isUsageFeature flag
   */
  private async calculateUsageOfFeatures({
    projectId,
    customerId,
    featureSlug,
    entitlement,
    billingStartAt,
    billingEndAt,
    usageData: providedUsageData,
  }: {
    projectId: string
    customerId: string
    featureSlug: string
    entitlement: Omit<Entitlement, "id">
    billingStartAt: number
    billingEndAt: number
    usageData?: { featureSlug: string; usage: number }[]
  }): Promise<
    Result<
      {
        usage: number
        isUsageFeature: boolean
      },
      UnPriceBillingError
    >
  > {
    // Validate billing window
    if (billingStartAt >= billingEndAt) {
      return Err(
        new UnPriceBillingError({
          message: `Invalid billing window: startAt (${billingStartAt}) must be before endAt (${billingEndAt})`,
        })
      )
    }

    const featureType = entitlement.featureType
    const aggregationMethod = entitlement.aggregationMethod
    const isUsageFeature = featureType !== "flat"

    // For non-usage features, return early with zero usage
    if (!isUsageFeature) {
      return Ok({
        usage: 0,
        isUsageFeature: false,
      })
    }

    // Use provided usage data if available, otherwise fetch it
    let usageData: { featureSlug: string; usage: number }[]
    if (providedUsageData && providedUsageData.length > 0) {
      usageData = providedUsageData
    } else {
      // Fetch TOTAL usage for this feature (no grant filtering)
      const { err: usageErr, val: fetchedUsageData } = await this.analytics.getUsageBillingFeatures(
        {
          customerId,
          projectId,
          features: [
            {
              featureSlug,
              aggregationMethod,
              featureType,
            },
          ],
          startAt: billingStartAt,
          endAt: billingEndAt,
        }
      )

      if (usageErr) {
        this.logger.error("Failed to get usage for feature", {
          featureSlug,
          customerId,
          projectId,
          billingStartAt,
          billingEndAt,
          error: usageErr.message,
        })
        return Err(new UnPriceBillingError({ message: usageErr.message }))
      }

      usageData = fetchedUsageData
    }

    // Extract usage values for the specific feature
    const featureUsage = usageData.find((u) => u.featureSlug === featureSlug)
    const currentCycleUsage = featureUsage?.usage ?? 0

    return Ok({
      usage: currentCycleUsage,
      isUsageFeature: true,
    })
  }

  /**
   * Calculates proration for a grant within a billing window.
   */
  private calculateGrantProration({
    grant,
    billingStartAt,
    billingEndAt,
    resetConfig,
  }: {
    grant: z.infer<typeof grantSchemaExtended>
    billingStartAt: number
    billingEndAt: number
    resetConfig: Omit<EntitlementState, "id">["resetConfig"]
  }): { prorationFactor: number; referenceCycleStart: number; referenceCycleEnd: number } {
    // Calculate proration based on the billing period
    // The service window is the intersection of the grant active period and the billing cycle
    const grantServiceStart = Math.max(billingStartAt, grant.effectiveAt)
    const grantServiceEnd = Math.min(billingEndAt, grant.expiresAt ?? Number.POSITIVE_INFINITY)

    // if grant is trial, proration factor should be 0
    if (grant.type === "trial") {
      return {
        prorationFactor: 0,
        referenceCycleStart: grantServiceStart,
        referenceCycleEnd: grantServiceEnd,
      }
    }

    if (resetConfig) {
      const proration = calculateProration({
        serviceStart: grantServiceStart,
        serviceEnd: grantServiceEnd,
        effectiveStartDate: grant.effectiveAt, // used for anchor calculation
        billingConfig: {
          name: resetConfig.name,
          billingInterval: resetConfig.resetInterval,
          billingIntervalCount: resetConfig.resetIntervalCount,
          planType: resetConfig.planType,
          billingAnchor: resetConfig.resetAnchor,
        },
      })
      return proration
    }

    return {
      prorationFactor: 1,
      referenceCycleStart: grantServiceStart,
      referenceCycleEnd: grantServiceEnd,
    }
  }

  /**
   * Calculates quantity for a grant based on feature type and remaining usage.
   */
  private calculateGrantQuantity({
    grant,
    remainingUsage,
  }: {
    grant: z.infer<typeof grantSchemaExtended>
    remainingUsage: number
  }): number {
    if (["tier", "usage", "package"].includes(grant.featurePlanVersion.featureType)) {
      const grantLimit = grant.limit ?? Number.POSITIVE_INFINITY
      return Math.min(remainingUsage, grantLimit)
    }

    // For non-usage grants, quantity is based on grant units
    if (grant.featurePlanVersion.featureType === "flat") {
      return grant.units ?? 1
    }

    return grant.units ?? 0
  }

  /**
   * Processes a single grant and calculates its price contribution.
   */
  private processGrant({
    grant,
    billingStartAt,
    billingEndAt,
    resetConfig,
    remainingUsage,
    featureSlug,
  }: {
    grant: z.infer<typeof grantSchemaExtended>
    billingStartAt: number
    billingEndAt: number
    resetConfig: Omit<EntitlementState, "id">["resetConfig"]
    remainingUsage: number
    featureSlug: string
  }): Result<ComputeCurrentUsageResult, UnPriceBillingError> {
    // Calculate grant service window
    const grantServiceStart = Math.max(billingStartAt, grant.effectiveAt)
    const grantServiceEnd = Math.min(billingEndAt, grant.expiresAt ?? Number.POSITIVE_INFINITY)

    // Validate grant service window
    if (grantServiceStart >= grantServiceEnd) {
      return Err(new UnPriceBillingError({ message: "Invalid grant service window" }))
    }

    // Calculate quantity
    const quantity = this.calculateGrantQuantity({
      grant,
      remainingUsage,
    })

    // Calculate free units
    const freeUnitsResult = calculateFreeUnits({
      config: grant.featurePlanVersion.config,
      featureType: grant.featurePlanVersion.featureType,
    })

    if (freeUnitsResult.err) {
      this.logger.warn("Failed to calculate free units for grant", {
        grantId: grant.id,
        featureSlug,
        error: freeUnitsResult.err.message,
      })
    }

    const freeUnits = freeUnitsResult.val ?? 0
    const grantLimit = grant.limit ?? Number.POSITIVE_INFINITY

    // Calculate proration
    const proration = this.calculateGrantProration({
      grant,
      billingStartAt,
      billingEndAt,
      resetConfig,
    })

    // Calculate price
    const { val: priceCalculation, err: priceCalculationErr } = calculatePricePerFeature({
      config: grant.featurePlanVersion.config,
      featureType: grant.featurePlanVersion.featureType,
      quantity,
      prorate: proration.prorationFactor,
    })

    if (priceCalculationErr) {
      this.logger.error("Error calculating price for grant", {
        grantId: grant.id,
        featureSlug,
        quantity,
        prorationFactor: proration.prorationFactor,
        error: priceCalculationErr.message,
      })
      return Err(new UnPriceBillingError({ message: priceCalculationErr.message }))
    }

    return Ok({
      grantId: grant.id,
      price: priceCalculation,
      prorate: proration.prorationFactor,
      cycleStartAt: grant.effectiveAt,
      cycleEndAt: grant.expiresAt ?? Number.POSITIVE_INFINITY,
      usage: quantity,
      included: freeUnits,
      limit: grantLimit,
      isTrial: grant.type === "trial",
    })
  }

  /**
   * Calculates the price for a feature based on grants, usage, and billing period.
   * Handles waterfall attribution of usage across multiple grants and calculates proration.
   */
  public async calculateFeaturePrice(
    params:
      | {
          projectId: string
          customerId: string
          featureSlug: string
          now: number
          grants?: z.infer<typeof grantSchemaExtended>[]
          startAt?: never
          endAt?: never
          usageData?: { featureSlug: string; usage: number }[]
        }
      | {
          projectId: string
          customerId: string
          featureSlug: string
          startAt: number
          endAt: number
          grants?: z.infer<typeof grantSchemaExtended>[]
          now?: never
          usageData?: { featureSlug: string; usage: number }[]
        }
  ): Promise<Result<ComputeCurrentUsageResult[], UnPriceBillingError>> {
    const {
      projectId,
      customerId,
      featureSlug,
      grants: providedGrants,
      usageData: providedUsageData,
    } = params
    const now = "now" in params ? params.now : undefined
    const startAt = "startAt" in params ? params.startAt : undefined
    const endAt = "endAt" in params ? params.endAt : undefined

    // Validate required parameters
    if (!projectId || !customerId || !featureSlug) {
      return Err(
        new UnPriceBillingError({
          message: "Missing required parameters: projectId, customerId, or featureSlug",
        })
      )
    }

    // Fetch grants if not provided
    let grants: z.infer<typeof grantSchemaExtended>[]
    if (providedGrants) {
      grants = providedGrants
    } else {
      // Fetch all grants for customer and filter by feature slug
      const { val: grantsResult, err: grantsErr } = await this.grantsManager.getGrantsForCustomer(
        now !== undefined
          ? { customerId, projectId, now }
          : { customerId, projectId, startAt: startAt!, endAt: endAt! }
      )

      if (grantsErr) {
        this.logger.error("Failed to get grants for customer", {
          customerId,
          projectId,
          featureSlug,
          error: grantsErr.message,
        })
        return Err(new UnPriceBillingError({ message: grantsErr.message }))
      }

      // Filter grants by feature slug
      grants = grantsResult.grants.filter((g) => g.featurePlanVersion.feature.slug === featureSlug)
    }

    if (grants.length === 0) {
      return Ok([])
    }

    // Compute entitlement state
    const computedStateResult = await this.grantsManager.computeEntitlementState({
      grants,
      customerId,
      projectId,
    })

    if (computedStateResult.err) {
      this.logger.error("Failed to compute entitlement state", {
        featureSlug,
        customerId,
        projectId,
        error: computedStateResult.err.message,
      })
      return Err(new UnPriceBillingError({ message: computedStateResult.err.message }))
    }

    const entitlement = computedStateResult.val

    // Calculate billing window using extracted method
    const billingWindowResult = this.calculateBillingWindow({
      entitlement,
      now,
      startAt,
      endAt,
    })

    if (billingWindowResult.err) {
      return Err(billingWindowResult.err)
    }

    const { billingStartAt, billingEndAt } = billingWindowResult.val

    // Calculate usage using extracted method
    const usageResult = await this.calculateUsageOfFeatures({
      projectId,
      customerId,
      featureSlug,
      entitlement,
      billingStartAt,
      billingEndAt,
      usageData: providedUsageData,
    })

    if (usageResult.err) {
      return Err(usageResult.err)
    }

    const { usage, isUsageFeature } = usageResult.val

    // Track remaining usage for waterfall attribution
    let remainingUsage = usage
    const result: ComputeCurrentUsageResult[] = []

    // Waterfall attribution per priority from highest to lowest
    const sortedGrants = [...grants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    for (const grant of sortedGrants) {
      // For usage features, break early if all usage is attributed
      if (isUsageFeature && remainingUsage <= 0) {
        break
      }

      // Process grant and calculate price
      const grantResult = this.processGrant({
        grant,
        billingStartAt,
        billingEndAt,
        resetConfig: entitlement.resetConfig,
        remainingUsage,
        featureSlug,
      })

      if (grantResult.err) {
        // Log error but continue processing other grants
        this.logger.error("Failed to process grant", {
          grantId: grant.id,
          featureSlug,
          error: grantResult.err.message,
        })
        continue
      }

      const grantPrice = grantResult.val
      if (!grantPrice) {
        // Grant was skipped (invalid service window)
        continue
      }

      result.push(grantPrice)

      // Decrement remaining usage if it's usage feature
      if (isUsageFeature) {
        remainingUsage -= grantPrice.usage
      }
    }

    // Unattributed Overage (Only for usage features)
    // This represents usage that exceeds all grant limits
    // this shouldn't happen, but just in case
    if (isUsageFeature && remainingUsage > 0) {
      // grants have the currency code in the feature plan version
      const currencyCode =
        grants[0]?.featurePlanVersion.config?.price?.dinero?.currency.code ?? "USD"
      const currencyDinero = currencies[currencyCode as keyof typeof currencies]
      const zeroDinero = dinero({ amount: 0, currency: currencyDinero })

      result.push({
        grantId: null,
        price: {
          unitPrice: {
            dinero: zeroDinero,
            displayAmount: `${formatMoney("0", currencyCode)}`,
          },
          subtotalPrice: {
            dinero: zeroDinero,
            displayAmount: `${formatMoney("0", currencyCode)}`,
          },
          totalPrice: {
            dinero: zeroDinero,
            displayAmount: `${formatMoney("0", currencyCode)}`,
          },
        },
        prorate: 1,
        cycleStartAt: billingStartAt,
        cycleEndAt: billingEndAt,
        usage: remainingUsage,
        included: 0,
        limit: 0,
        isTrial: false,
      })
    }

    return Ok(result)
  }

  public async estimatePriceCurrentUsage({
    customerId,
    projectId,
    now = Date.now(),
  }: {
    customerId: string
    projectId: string
    now?: number
  }): Promise<Result<ComputeCurrentUsageResult[], UnPriceBillingError>> {
    const result: ComputeCurrentUsageResult[] = []

    // Get all active grants for the customer to determine which features to process
    const { val: grantsResult, err: grantsErr } = await this.grantsManager.getGrantsForCustomer({
      customerId,
      projectId,
      now,
    })

    if (grantsErr) {
      this.logger.error("Failed to get grants for customer", {
        customerId,
        projectId,
        error: grantsErr.message,
      })
      return Err(new UnPriceBillingError({ message: grantsErr.message }))
    }

    if (grantsResult.grants.length === 0) {
      return Ok([])
    }

    // Group grants by feature slug to process each feature
    const grantsByFeature = new Map<string, typeof grantsResult.grants>()

    for (const grant of grantsResult.grants) {
      const featureSlug = grant.featurePlanVersion.feature.slug
      if (!grantsByFeature.has(featureSlug)) {
        grantsByFeature.set(featureSlug, [])
      }
      grantsByFeature.get(featureSlug)!.push(grant)
    }

    // Pre-compute entitlement states and billing windows for all features to batch fetch usage data
    const usageFeaturesToFetch: Array<{
      featureSlug: string
      aggregationMethod: AggregationMethod
      featureType: FeatureType
      billingStartAt: number
      billingEndAt: number
    }> = []

    const featureMetadata = new Map<
      string,
      {
        grants: typeof grantsResult.grants
        entitlement: Omit<Entitlement, "id">
        billingStartAt: number
        billingEndAt: number
      }
    >()

    for (const [featureSlug, featureGrants] of grantsByFeature.entries()) {
      // Compute entitlement state to determine feature type and billing window
      const computedStateResult = await this.grantsManager.computeEntitlementState({
        grants: featureGrants,
        customerId,
        projectId,
      })

      if (computedStateResult.err) {
        this.logger.error("Failed to compute entitlement state", {
          featureSlug,
          error: computedStateResult.err.message,
        })
        continue
      }

      const entitlement = computedStateResult.val

      // Calculate billing window using extracted method
      const billingWindowResult = this.calculateBillingWindow({
        entitlement,
        now,
      })

      if (billingWindowResult.err) {
        this.logger.error("Failed to calculate billing window", {
          featureSlug,
          error: billingWindowResult.err.message,
        })
        continue
      }

      const { billingStartAt, billingEndAt } = billingWindowResult.val

      featureMetadata.set(featureSlug, {
        grants: featureGrants,
        entitlement,
        billingStartAt,
        billingEndAt,
      })

      // Collect usage features for batch fetching
      if (entitlement.featureType !== "flat") {
        usageFeaturesToFetch.push({
          featureSlug,
          aggregationMethod: entitlement.aggregationMethod,
          featureType: entitlement.featureType,
          billingStartAt,
          billingEndAt,
        })
      }
    }

    // Batch fetch usage data for all usage features
    // Group by billing window to make optimal queries
    const usageDataByWindow = new Map<string, { featureSlug: string; usage: number }[]>()

    if (usageFeaturesToFetch.length > 0) {
      // Group features by billing window to minimize queries
      const featuresByWindow = new Map<string, typeof usageFeaturesToFetch>()
      for (const feature of usageFeaturesToFetch) {
        const windowKey = `${feature.billingStartAt}-${feature.billingEndAt}`
        if (!featuresByWindow.has(windowKey)) {
          featuresByWindow.set(windowKey, [])
        }
        featuresByWindow.get(windowKey)!.push(feature)
      }

      // Fetch usage data for each unique billing window
      for (const [windowKey, features] of featuresByWindow.entries()) {
        const [billingStartAt, billingEndAt] = windowKey.split("-").map(Number) as [number, number]

        const { err: usageErr, val: fetchedUsageData } =
          await this.analytics.getUsageBillingFeatures({
            customerId,
            projectId,
            features: features.map((f) => ({
              featureSlug: f.featureSlug,
              aggregationMethod: f.aggregationMethod,
              featureType: f.featureType,
            })),
            startAt: billingStartAt,
            endAt: billingEndAt,
          })

        if (usageErr) {
          this.logger.error("Failed to batch fetch usage data", {
            error: usageErr.message,
            windowKey,
          })
          // Continue with other windows, but log error
          continue
        }

        usageDataByWindow.set(windowKey, fetchedUsageData)
      }
    }

    // Process each feature - pass grants and usage data to avoid duplicate fetching
    for (const [featureSlug, metadata] of featureMetadata.entries()) {
      // Get usage data for this feature's billing window if it's a usage feature
      let usageDataForFeature: { featureSlug: string; usage: number }[] | undefined

      if (metadata.entitlement.featureType === "usage") {
        const windowKey = `${metadata.billingStartAt}-${metadata.billingEndAt}`
        usageDataForFeature = usageDataByWindow.get(windowKey)
      }

      const calculationResult = await this.calculateFeaturePrice({
        projectId,
        customerId,
        featureSlug,
        now,
        grants: metadata.grants, // Pass already-fetched grants for efficiency
        usageData: usageDataForFeature, // Pass pre-fetched usage data
      })

      if (calculationResult.err) {
        this.logger.error("Failed to calculate feature price", {
          featureSlug,
          error: calculationResult.err.message,
        })
        continue
      }

      result.push(...calculationResult.val)
    }

    return Ok(result)
  }

  // all variables that affect the invoice should be included in the statement key
  // this way we can group invoices together and bill them together
  // this is useful for co-billing and for the invoice scheduler
  // also helps us invoice phases changes when they share the same variables,
  // or split them into multiple invoices we things like currency and payment provider changes
  private async computeStatementKey(input: {
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
}
