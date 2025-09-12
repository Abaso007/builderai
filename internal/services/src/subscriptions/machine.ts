import type { Analytics } from "@unprice/analytics"
import { and as dbAnd, eq } from "@unprice/db"
import { subscriptions } from "@unprice/db/schema"
import type { Customer, Subscription, SubscriptionStatus } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import {
  type AnyActorRef,
  and,
  assign,
  createActor,
  fromPromise,
  not,
  setup,
  waitFor,
} from "xstate"

import { db } from "../utils/db"
import { UnPriceMachineError } from "./errors"

import type { CustomerService } from "../customers/service"
import sendCustomerNotification, { logTransition, updateSubscription } from "./actions"
import {
  canRenew,
  hasDueBillingPeriods,
  hasValidPaymentMethod,
  isAutoRenewEnabled,
  isCurrentPhaseNull,
  isTrialExpired,
} from "./guards"
import {
  generateBillingPeriods,
  invoiceSubscription,
  loadSubscription,
  renewSubscription,
} from "./invokes"
import type {
  MachineTags,
  SubscriptionActions,
  SubscriptionContext,
  SubscriptionEvent,
  SubscriptionGuards,
  SusbriptionMachineStatus,
} from "./types"

/**
 * Subscription Manager
 *
 * Handles subscription lifecycle using a state machine.
 * Supports trials, billing cycles, and plan changes.
 *
 * States:
 * - pending: Initial state before we determine the actual starting state
 * - trialing: Initial trial period
 * - active: Paid and active subscription
 * - past_due: Failed payment, awaiting resolution
 * - canceled: Terminated subscription
 * - expired: Final state for expired subscriptions
 */
export class SubscriptionMachine {
  private subscriptionId: string
  private projectId: string
  private analytics: Analytics
  private logger: Logger
  private actor!: AnyActorRef
  private waitUntil: (p: Promise<unknown>) => void
  private now: number
  private customerService: CustomerService
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private machine: any
  // Serializes event sends to this actor to avoid concurrent transitions/races.
  // Each send chains onto this promise, so events are processed in order.
  // This is per-instance (per-subscription) and prevents overlapping invokes.
  // when i send multiple events at the same time, the events are processed in order
  // like sendAndWait({ type: "RENEW" }, { states: ["active", "expired"], timeout: 15000 })
  // and sendAndWait({ type: "INVOICE" }, { states: ["active"], timeout: 30000 })
  // the events are processed in order so I don't need to await the first event to be processed before sending the second event
  private sendQueue: Promise<unknown> = Promise.resolve()

  private constructor({
    subscriptionId,
    projectId,
    analytics,
    logger,
    waitUntil,
    customer,
    now,
  }: {
    subscriptionId: string
    projectId: string
    analytics: Analytics
    logger: Logger
    customer: CustomerService
    waitUntil: (p: Promise<unknown>) => void
    now: number
  }) {
    this.subscriptionId = subscriptionId
    this.projectId = projectId
    this.analytics = analytics
    this.logger = logger
    this.waitUntil = waitUntil
    this.now = now
    this.customerService = customer
    this.machine = this.createMachineSubscription()
  }

  /**
   * Creates the state machine definition
   */
  private createMachineSubscription() {
    return setup({
      types: {} as {
        context: SubscriptionContext
        events: SubscriptionEvent
        guards: SubscriptionGuards
        actions: SubscriptionActions
        states: SubscriptionStatus
        tags: MachineTags
        input: {
          now: number
          subscriptionId: string
          projectId: string
        }
      },
      actors: {
        generateBillingPeriods: fromPromise(
          async ({ input }: { input: { context: SubscriptionContext; logger: Logger } }) => {
            const result = await generateBillingPeriods({
              context: input.context,
              logger: input.logger,
            })

            return result
          }
        ),
        loadSubscription: fromPromise(
          async ({ input }: { input: { context: SubscriptionContext; logger: Logger } }) => {
            const result = await loadSubscription({
              context: input.context,
              logger: input.logger,
            })

            return result
          }
        ),
        invoiceSubscription: fromPromise(
          async ({ input }: { input: { context: SubscriptionContext; logger: Logger } }) => {
            const result = await invoiceSubscription({
              context: input.context,
              logger: input.logger,
            })

            return result
          }
        ),
        renewSubscription: fromPromise(
          async ({
            input,
          }: {
            input: {
              context: SubscriptionContext
              logger: Logger
              customerService: CustomerService
            }
          }) => {
            const result = await renewSubscription({
              context: input.context,
              logger: input.logger,
              customerService: input.customerService,
            })

            return result
          }
        ),
      },
      guards: {
        hasDueBillingPeriods: hasDueBillingPeriods,
        isTrialExpired: isTrialExpired,
        canRenew: canRenew,
        hasValidPaymentMethod: ({ context }) =>
          hasValidPaymentMethod({ context, logger: this.logger }),
        isAutoRenewEnabled: isAutoRenewEnabled,
        isCurrentPhaseNull: isCurrentPhaseNull,
      },
      actions: {
        logStateTransition: ({ context, event }) =>
          logTransition({ context, event, logger: this.logger }),
        notifyCustomer: ({ context, event }) =>
          sendCustomerNotification({ context, event, logger: this.logger }),
      },
    }).createMachine({
      id: "subscriptionMachine",
      initial: "loading",
      context: ({ input }) =>
        ({
          now: input.now,
          subscriptionId: input.subscriptionId,
          projectId: input.projectId,
          paymentMethodId: null,
          requiredPaymentMethod: false,
          phases: [],
          currentPhase: null,
          openInvoices: [],
          hasDueBillingPeriods: false,
          hasOpenInvoices: false,
          subscription: {} as Subscription,
          customer: {} as Customer,
        }) as SubscriptionContext,
      output: ({ context }) => ({
        error: context.error,
        status: context.subscription?.status,
      }),
      states: {
        loading: {
          tags: ["machine", "loading"],
          description:
            "Loading the subscription. This is the initial state which is not reported to the database",
          invoke: {
            id: "loadSubscription",
            src: "loadSubscription",
            input: ({ context }) => ({
              context,
              logger: this.logger,
            }),
            onDone: {
              target: "restored", // transitional state that will be used to determine the next state
              actions: [
                assign({
                  now: ({ event }) => event.output.now,
                  subscription: ({ event }) => event.output.subscription,
                  currentPhase: ({ event }) => event.output.currentPhase,
                  customer: ({ event }) => event.output.customer,
                  paymentMethodId: ({ event }) => event.output.paymentMethodId,
                  requiredPaymentMethod: ({ event }) => event.output.requiredPaymentMethod,
                }),
              ],
            },
            onError: {
              target: "error",
              actions: assign({
                error: ({ event }) => {
                  return event.error as Error
                },
              }),
            },
          },
        },
        error: {
          tags: ["machine", "error"],
          description: "Subscription error, it will throw an error as a final state",
          type: "final",
          entry: ({ context, event }) => {
            // log the error
            this.logger.error(context.error?.message ?? "Unknown error", {
              subscriptionId: this.subscriptionId,
              customerId: context.customer.id,
              currentPhaseId: context.currentPhase?.id,
              projectId: this.projectId,
              now: this.now,
              event: JSON.stringify(event),
            })

            // throw an error to be caught by the machine
            throw context.error
          },
        },
        restored: {
          description: "Subscription restored, transition to the correct state",
          tags: ["machine", "loading"],
          always: [
            {
              target: "trialing",
              guard: ({ context }) => context.subscription.status === "trialing",
              actions: "logStateTransition",
            },
            {
              target: "active",
              guard: ({ context }) => context.subscription.status === "active",
              actions: "logStateTransition",
            },
            {
              target: "past_due",
              guard: ({ context }) => context.subscription.status === "past_due",
              actions: "logStateTransition",
            },
            {
              target: "canceled",
              guard: ({ context }) => context.subscription.status === "canceled",
              actions: "logStateTransition",
            },
            {
              target: "expired",
              guard: ({ context }) => context.subscription.status === "expired",
              actions: "logStateTransition",
            },
            // if the subscription is in an unknown state, transition to error
            {
              target: "error",
              actions: [
                "logStateTransition",
                assign({
                  error: () => ({
                    message: "Subscription is in an unknown state",
                  }),
                }),
              ],
            },
          ],
        },
        trialing: {
          tags: ["subscription"],
          description: "Subscription is trialing, meaning is waiting for the trial to end",
          on: {
            BILLING_PERIOD: {
              target: "generating_billing_periods",
              actions: "logStateTransition",
            },
            // first possible event is renew which will end the trial and update the phase
            RENEW: [
              {
                guard: "isCurrentPhaseNull", // verify that the subscription has a current phase
                target: "error", // if the subscription has no current phase, throw an error
                actions: assign({
                  error: () => ({
                    message: "Subscription has no active phase",
                  }),
                }),
              },
              {
                guard: and(["isTrialExpired", "hasValidPaymentMethod"]), // verify that the trial has expired and the payment method is valid
                target: "renewing", // if the trial has expired and the payment method is valid, transition to the invoicing state
                actions: "logStateTransition",
              },
              {
                target: "error", // if the trial has not expired or the payment method is invalid, throw an error
                actions: assign({
                  error: ({ context }) => {
                    const trialEndAt = context.currentPhase?.trialEndsAt! // the state machine already verified that the subscription has a current phase
                    const trialEndAtDate = new Date(trialEndAt).toLocaleString()

                    const isExpired = isTrialExpired({ context })
                    const isPaymentMethodValid = hasValidPaymentMethod({
                      context,
                      logger: this.logger,
                    })

                    if (!isExpired) {
                      return {
                        message: `Cannot end trial, dates are not due yet at ${trialEndAtDate}`,
                      }
                    }

                    if (!isPaymentMethodValid) {
                      return {
                        message: `Cannot end trial, payment method is invalid at ${trialEndAtDate}`,
                      }
                    }

                    return {
                      message: `Cannot end trial, dates are not due yet and payment method is invalid at ${trialEndAtDate}`,
                    }
                  },
                }),
              },
            ],
          },
        },
        generating_billing_periods: {
          tags: ["machine", "transition"],
          description: "Generating billing periods for the subscription",
          invoke: {
            id: "generateBillingPeriods",
            src: "generateBillingPeriods",
            input: ({ context }) => ({ context, logger: this.logger }),
            onDone: {
              target: "active",
              actions: [
                assign({
                  subscription: ({ event, context }) => {
                    if (event.output.subscription) {
                      return event.output.subscription
                    }

                    return context.subscription
                  },
                }),
                "logStateTransition",
                "notifyCustomer",
              ],
            },
            onError: {
              target: "error",
              actions: [
                // update the metadata for the subscription to keep track of the reason
                ({ context }) =>
                  updateSubscription({
                    context,
                    subscription: {
                      metadata: {
                        reason: "invoice_failed",
                        note: "Invoice failed after trying to invoice",
                      },
                    },
                  }),
                assign({
                  error: ({ event }) => ({
                    message: `Invoice failed: ${(event.error as Error)?.message ?? "Unknown error"}`,
                  }),
                }),
                "logStateTransition",
              ],
            },
          },
        },
        invoicing: {
          tags: ["machine", "transition"],
          description: "Invoicing the subscription depending on the whenToBill setting",
          invoke: {
            id: "invoiceSubscription",
            src: "invoiceSubscription",
            input: ({ context }) => ({ context, logger: this.logger }),
            onDone: {
              target: "active",
              actions: [
                assign({
                  subscription: ({ event, context }) => {
                    if (event.output.subscription) {
                      return event.output.subscription
                    }

                    return context.subscription
                  },
                }),
                "logStateTransition",
                "notifyCustomer",
              ],
            },
            onError: {
              target: "error",
              actions: [
                // update the metadata for the subscription to keep track of the reason
                ({ context }) =>
                  updateSubscription({
                    context,
                    subscription: {
                      metadata: {
                        reason: "invoice_failed",
                        note: "Invoice failed after trying to invoice",
                      },
                    },
                  }),
                assign({
                  error: ({ event }) => ({
                    message: `Invoice failed: ${(event.error as Error)?.message ?? "Unknown error"}`,
                  }),
                }),
                "logStateTransition",
              ],
            },
          },
        },
        renewing: {
          tags: ["machine", "transition"],
          description: "Renewing the subscription, update billing dates for the next cycle",
          invoke: {
            id: "renewSubscription",
            src: "renewSubscription",
            input: ({ context }) => ({
              context,
              customerService: this.customerService,
              logger: this.logger,
            }),
            onDone: {
              target: "active",
              actions: [
                assign({
                  subscription: ({ event, context }) => {
                    if (event.output.subscription) {
                      return event.output.subscription
                    }

                    return context.subscription
                  },
                }),
                "logStateTransition",
                "notifyCustomer",
              ],
            },
            onError: {
              target: "error",
              actions: assign({
                error: ({ event }) => {
                  const err = event.error as Error
                  return {
                    message: err.message,
                  }
                },
              }),
            },
          },
        },
        active: {
          tags: ["subscription"],
          description: "Subscription is active",
          on: {
            CANCEL: {
              target: "canceling",
              actions: "logStateTransition",
            },
            BILLING_PERIOD: {
              target: "generating_billing_periods",
              actions: "logStateTransition",
            },
            CHANGE: {
              target: "changing",
              actions: "logStateTransition",
            },
            PAYMENT_SUCCESS: {
              target: "active",
              actions: ["logStateTransition"],
            },
            PAYMENT_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Payment failed", event)
                },
              ],
            },
            INVOICE_SUCCESS: {
              target: "active",
              actions: ["logStateTransition"],
            },
            INVOICE_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Invoice failed", event)
                },
              ],
            },
            RENEW: [
              {
                guard: "isCurrentPhaseNull",
                target: "error",
                actions: assign({
                  error: () => ({
                    message: "Subscription has no active phase",
                  }),
                }),
              },
              {
                guard: and(["canRenew", "isAutoRenewEnabled"]), // only renew if the subscription can be renewed and auto renew is enabled
                target: "renewing",
                actions: "logStateTransition",
              },
              {
                guard: not("isAutoRenewEnabled"), // if auto renew is disabled, expire the subscription
                target: "expired",
                actions: "logStateTransition",
              },
              {
                target: "error",
                actions: assign({
                  error: ({ context }) => {
                    const renew = canRenew({ context })
                    const autoRenew = isAutoRenewEnabled({ context })

                    if (!autoRenew) {
                      return {
                        message: "Cannot renew subscription, auto renew is disabled",
                      }
                    }

                    if (!renew) {
                      return {
                        message: "Cannot renew subscription, subscription is not due to be renewed",
                      }
                    }

                    return {
                      message:
                        "Cannot renew subscription, dates are not due yet and auto renew is disabled",
                    }
                  },
                }),
              },
            ],
            INVOICE: [
              {
                guard: "isCurrentPhaseNull",
                target: "error",
                actions: assign({
                  error: () => ({
                    message: "Subscription has no active phase",
                  }),
                }),
              },
              {
                guard: and(["hasValidPaymentMethod", "hasDueBillingPeriods"]),
                target: "invoicing",
                actions: "logStateTransition",
              },
              {
                target: "error",
                actions: assign({
                  error: () => {
                    return {
                      message: "Cannot invoice subscription, payment method is invalid",
                    }
                  },
                }),
              },
            ],
          },
        },
        past_due: {
          tags: ["subscription"],
          description: "Subscription is past due can retry payment or invoice",
          on: {
            PAYMENT_SUCCESS: {
              target: "active",
              actions: ["logStateTransition"],
            },
            BILLING_PERIOD: {
              target: "generating_billing_periods",
              actions: "logStateTransition",
            },
            PAYMENT_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Payment failed", event)
                },
              ],
            },
            INVOICE_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Invoice failed", event)
                },
              ],
            },
            INVOICE_SUCCESS: {
              target: "active",
              actions: ["logStateTransition"],
            },
            CANCEL: {
              target: "canceled",
              actions: "logStateTransition",
            },
            INVOICE: [
              {
                guard: "isCurrentPhaseNull",
                target: "error",
                actions: assign({
                  error: () => ({
                    message: "Subscription has no active phase",
                  }),
                }),
              },
              {
                guard: and(["hasValidPaymentMethod", "hasDueBillingPeriods"]),
                target: "invoicing",
                actions: "logStateTransition",
              },
              {
                target: "error",
                actions: assign({
                  error: () => ({
                    message: "Cannot invoice subscription yet, payment method is invalid",
                  }),
                }),
              },
            ],
          },
        },
        // TODO: implement the rest of the states as they become relevant
        canceling: {
          tags: ["machine", "transition"],
          description: "Canceling the subscription, update billing dates",
        },
        changing: {
          tags: ["machine", "transition"],
          description: "Changing the subscription, update billing dates",
        },
        expiring: {
          tags: ["machine", "transition"],
          description: "Subscription expired, no more payments will be made",
          type: "final",
        },
        canceled: {
          tags: ["subscription", "final"],
          type: "final",
          description: "Subscription canceled, no more payments will be made",
        },
        expired: {
          tags: ["subscription", "final"],
          description: "Subscription expired, no more payments will be made",
          type: "final",
        },
      },
    })
  }

  private async initialize(): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    this.actor = createActor(this.machine, {
      input: {
        subscriptionId: this.subscriptionId,
        projectId: this.projectId,
        now: this.now,
      },
    })

    // Subscribe to ALL state changes and persist them
    let lastPersisted: SubscriptionStatus | null = null

    this.actor.subscribe({
      next: async (snapshot) => {
        if (!snapshot.changed) return
        if (!snapshot.hasTag("subscription")) return

        const currentState = snapshot.value as SusbriptionMachineStatus
        if (currentState === lastPersisted) return

        try {
          await db
            .update(subscriptions)
            .set({
              status: currentState as SubscriptionStatus,
              active: !["idle", "expired", "canceled"].includes(currentState),
            })
            .where(
              dbAnd(
                eq(subscriptions.id, this.subscriptionId),
                eq(subscriptions.projectId, this.projectId)
              )
            )

          lastPersisted = currentState as SubscriptionStatus
        } catch (err) {
          this.logger.error("Failed to update subscription status", {
            subscriptionId: this.subscriptionId,
            projectId: this.projectId,
            state: currentState,
            error: (err as Error).message,
          })
        }
      },
    })

    // Start the actor
    this.actor.start()

    // Wait for initialization to complete
    const result = await this.waitFor({ timeout: 5000, tag: "subscription" })

    if (result.err) {
      return Err(result.err)
    }

    return Ok(result.val)
  }

  public getState(): SusbriptionMachineStatus {
    return this.actor.getSnapshot().value as SusbriptionMachineStatus
  }

  public static async create(payload: {
    subscriptionId: string
    projectId: string
    analytics: Analytics
    logger: Logger
    customer: CustomerService
    now: number
    waitUntil: (p: Promise<unknown>) => void
  }): Promise<Result<SubscriptionMachine, UnPriceMachineError>> {
    const subscription = new SubscriptionMachine(payload)

    try {
      const result = await subscription.initialize()

      if (result.err) {
        return Err(result.err)
      }

      return Ok(subscription)
    } catch (error) {
      return Err(new UnPriceMachineError({ message: (error as Error).message ?? "Unknown error" }))
    }
  }

  // Sends an event and waits until the machine reaches one of the target states or tag.
  // Uses waitFor under the hood; set longer timeouts for I/O-heavy transitions (e.g., invoicing).
  private async sendAndWait(
    event: SubscriptionEvent,
    opts?: { states?: SusbriptionMachineStatus[]; tag?: MachineTags; timeout?: number }
  ): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    // serialize sends to this actor
    const run = async () => {
      const snapshot = this.actor.getSnapshot()
      if (!snapshot.can(event)) {
        return Err(
          new UnPriceMachineError({
            message: `Transition not allowed from ${snapshot.value} via ${event.type}`,
          })
        )
      }
      this.actor.send(event)
      const res = await this.waitFor({
        states: opts?.states,
        tag: opts?.tag,
        timeout: opts?.timeout,
      })
      return res
    }

    // chain onto queue to keep order; ignore previous rejection
    this.sendQueue = this.sendQueue.then(run, run)
    return this.sendQueue as Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>>
  }

  private async waitFor({
    timeout = 10000,
    states,
    tag,
  }: {
    timeout?: number
    states?: SusbriptionMachineStatus[]
    tag?: MachineTags
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    try {
      const snap = await waitFor(
        this.actor,
        (s) => Boolean(states?.some((st) => s.matches(st)) || (tag && s.hasTag(tag))),
        { timeout }
      )
      return Ok(snap.value as SusbriptionMachineStatus)
    } catch (e) {
      return Err(new UnPriceMachineError({ message: (e as Error)?.message ?? "Timeout" }))
    }
  }

  /**
   * Renews the subscription for the next billing cycle
   */
  public async renew(): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return this.sendAndWait({ type: "RENEW" }, { tag: "subscription", timeout: 15000 })
  }

  public async invoice(): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return this.sendAndWait({ type: "INVOICE" }, { tag: "subscription", timeout: 30000 })
  }

  public async reportPaymentSuccess({
    invoiceId,
  }: {
    invoiceId: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait({ type: "PAYMENT_SUCCESS", invoiceId }, { states: ["active"] })
  }

  public async reportPaymentFailure({
    invoiceId,
    error,
  }: {
    invoiceId: string
    error: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait(
      { type: "PAYMENT_FAILURE", invoiceId, error },
      { states: ["past_due"] }
    )
  }

  public async reportInvoiceSuccess({
    invoiceId,
  }: {
    invoiceId: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait(
      {
        type: "INVOICE_SUCCESS",
        invoiceId,
      },
      { states: ["active"] }
    )
  }

  public async reportInvoiceFailure({
    invoiceId,
    error,
  }: {
    invoiceId: string
    error: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait(
      {
        type: "INVOICE_FAILURE",
        invoiceId,
        error,
      },
      { states: ["past_due"] }
    )
  }

  public async generateBillingPeriods(): Promise<
    Result<SusbriptionMachineStatus, UnPriceMachineError>
  > {
    return await this.sendAndWait({ type: "BILLING_PERIOD" }, { tag: "subscription" })
  }

  public async shutdown(timeout = 5000): Promise<void> {
    if (this.sendQueue) {
      try {
        await Promise.race([
          this.sendQueue,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeout)),
        ])
      } catch {}
    }
    this.actor.stop()
  }
}
