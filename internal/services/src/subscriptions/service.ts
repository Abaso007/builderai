import { type Database, type TransactionDatabase, and, eq } from "@unprice/db"
import {
  customerEntitlements,
  subscriptionItems,
  subscriptionPhases,
  subscriptions,
} from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
  type Customer,
  type CustomerEntitlement,
  type InsertSubscription,
  type InsertSubscriptionPhase,
  type PhaseStatus,
  type Subscription,
  type SubscriptionItemConfig,
  type SubscriptionItemExtended,
  type SubscriptionPhase,
  type SubscriptionPhaseExtended,
  type SubscriptionPhaseMetadata,
  createDefaultSubscriptionConfig,
  subscriptionInsertSchema,
  subscriptionPhaseInsertSchema,
  subscriptionPhaseSelectSchema,
} from "@unprice/db/validators"

import { Err, Ok, type Result, SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type { Analytics } from "@unprice/tinybird"
import type { Cache } from "../cache/service"
import { CustomerService } from "../customers/service"
import { UnPriceMachineError } from "../machine/errors"
import type { Metrics } from "../metrics"
import { configureBillingCycleSubscription } from "./billing"
import { UnPriceSubscriptionError } from "./errors"
import { InvoiceStateMachine } from "./invoice-machine"
import { PhaseMachine } from "./phase-machine"

export class SubscriptionService {
  private readonly db: Database | TransactionDatabase
  private readonly cache: Cache | undefined
  private readonly metrics: Metrics
  private readonly logger: Logger
  private readonly waitUntil: (p: Promise<unknown>) => void
  private readonly analytics: Analytics
  // map of phase id to phase machine
  private readonly phases: Map<string, SubscriptionPhaseExtended> = new Map()
  private subscription: Subscription | undefined
  private customer: Customer | undefined
  private initialized = false

  constructor({
    db,
    cache,
    metrics,
    logger,
    waitUntil,
    analytics,
  }: {
    db: Database | TransactionDatabase
    cache: Cache | undefined
    metrics: Metrics
    logger: Logger
    waitUntil: (p: Promise<unknown>) => void
    analytics: Analytics
  }) {
    this.db = db
    this.cache = cache
    this.metrics = metrics
    this.logger = logger
    this.waitUntil = waitUntil
    this.analytics = analytics
  }

  public async initPhaseMachines({
    subscriptionId,
    projectId,
    db,
  }: {
    subscriptionId: string
    projectId: string
    db?: Database | TransactionDatabase
  }): Promise<Result<void, UnPriceSubscriptionError>> {
    // get the active phases for the subscription
    const subscription = await (db ?? this.db).query.subscriptions.findFirst({
      with: {
        phases: {
          with: {
            subscription: {
              with: {
                customer: true,
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
            planVersion: {
              with: {
                planFeatures: true,
              },
            },
          },
        },
        customer: true,
      },

      where: (sub, { eq, and }) => and(eq(sub.id, subscriptionId), eq(sub.projectId, projectId)),
    })

    if (!subscription) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription not found",
        })
      )
    }

    if (subscription.phases.length === 0) {
      return Ok(undefined)
    }

    const { phases, customer, ...rest } = subscription

    for (const phase of phases) {
      this.phases.set(phase.id, phase)
    }

    // save the rest of the subscription
    this.subscription = rest
    this.customer = customer
    this.initialized = true

    return Ok(undefined)
  }

  // entitlements are the actual features that are assigned to a customer
  // sync the entitlements with the subscription items, meaning end entitlements or revoke them
  // given the new phases.
  // 1. get the active items for the subscription (paid ones)
  // 2. get the current entitlements for the customer
  // 3. compare the active items with the entitlements for the current phase
  // 4. if there is a difference, create a new entitlement, deactivate the old ones or update the units
  // 5. for custom entitlements we don't do anything, they are already synced
  // TODO: FIX THIS!!
  private async syncEntitlementsForSubscription({
    subscriptionId,
    projectId,
    customerId,
    now,
    db,
  }: {
    subscriptionId: string
    projectId: string
    customerId: string
    now: number
    db?: Database | TransactionDatabase
  }): Promise<Result<void, UnPriceSubscriptionError>> {
    // get the active phase for the subscription
    const subscription = await (db ?? this.db).query.subscriptions.findFirst({
      with: {
        phases: {
          // get active phase now
          where: (phase, { eq, and, gte, lte, isNull, or }) =>
            and(
              eq(phase.active, true),
              lte(phase.startAt, now),
              or(isNull(phase.endAt), gte(phase.endAt, now)),
              eq(phase.projectId, projectId)
            ),
          // phases are don't overlap, so we can use limit 1
          limit: 1,
          with: {
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
      where: (sub, { eq, and }) => and(eq(sub.id, subscriptionId), eq(sub.projectId, projectId)),
    })

    const customerService = new CustomerService({
      cache: this.cache,
      db: db ?? this.db,
      metrics: this.metrics,
      logger: this.logger,
      waitUntil: this.waitUntil,
      analytics: this.analytics,
    })

    // get all the active entitlements for the customer
    const { err, val } = await customerService.getEntitlementsByDate({
      customerId,
      projectId,
      // get the entitlements for the given date
      date: now,
      // we don't want to cache the entitlements here, because we want to get the latest ones
      noCache: true,
      // custom entitlements are not synced with the subscription items
      includeCustom: false,
    })

    if (err) {
      return Err(
        new UnPriceSubscriptionError({
          message: `Error getting entitlements: ${err.message}`,
        })
      )
    }

    const activeEntitlements = val
    const activePhase = subscription?.phases[0]
    const activeSubItems = activePhase?.items ?? []

    const activeSubItemsMap = new Map<string, SubscriptionItemExtended>()
    const entitlementsMap = new Map<
      string,
      Omit<CustomerEntitlement, "createdAtM" | "updatedAtM">
    >()

    for (const item of activeSubItems) {
      activeSubItemsMap.set(item.id, item)
    }

    for (const entitlement of activeEntitlements) {
      // there is a 1:1 relationship between the items and the entitlements
      // subItemId is null only for custom entitlements
      entitlementsMap.set(entitlement.subscriptionItemId!, entitlement)
    }
    // get the items that are not in the entitlements and create them
    // get the entitlements that are not in the items and deactivate them
    // update the lastUsageUpdateAt of the entitlements
    const entitiesToCreate: (typeof customerEntitlements.$inferInsert)[] = []
    const entitiesToUpdate: Pick<
      typeof customerEntitlements.$inferInsert,
      "id" | "lastUsageUpdateAt" | "updatedAtM" | "endAt" | "units"
    >[] = []
    const entitiesToDelete: string[] = []

    // if entitlements are not in the items, we create them
    // if entitlements are in the items, we update them with the end date of the phase

    // IMPORTANT: A customer can't have the same feature plan version assigned to multiple entitlements
    // Find items to create
    for (const item of activeSubItemsMap.values()) {
      if (!entitlementsMap.has(item.id)) {
        entitiesToCreate.push({
          id: newId("customer_entitlement"),
          projectId,
          customerId,
          subscriptionItemId: item.id,
          featurePlanVersionId: item.featurePlanVersionId,
          units: item.units,
          limit: item.featurePlanVersion.limit,
          usage: 0, // Initialize usage to 0
          featureSlug: item.featurePlanVersion.feature.slug,
          featureType: item.featurePlanVersion.featureType,
          aggregationMethod: item.featurePlanVersion.aggregationMethod,
          realtime: item.featurePlanVersion.metadata?.realtime ?? false,
          type: "feature",
          startAt: now,
          endAt: activePhase?.endAt ?? null,
          isCustom: false,
        })
      } else {
        const entitlement = entitlementsMap.get(item.id)!
        // if the entitlement is in the items, we update it with the end date of the phase
        // and the units of the item
        entitiesToUpdate.push({
          id: entitlement.id,
          endAt: activePhase?.endAt ?? null,
          units: item.units,
          lastUsageUpdateAt: now,
          updatedAtM: now,
        })
      }
    }

    // Find entitlements to delete
    for (const entitlement of entitlementsMap.values()) {
      if (!activeSubItemsMap.has(entitlement.subscriptionItemId!)) {
        entitiesToDelete.push(entitlement.id)
      }
    }

    // Perform database operations
    await (db ?? this.db).transaction(async (tx) => {
      try {
        for (const entity of entitiesToCreate) {
          await tx.insert(customerEntitlements).values(entity)
        }

        for (const entity of entitiesToUpdate) {
          await tx
            .update(customerEntitlements)
            .set(entity)
            .where(eq(customerEntitlements.id, entity.id))
        }

        for (const id of entitiesToDelete) {
          await tx
            .update(customerEntitlements)
            // if the entitlement is not in the items, end them immediately
            .set({ endAt: Date.now() })
            .where(eq(customerEntitlements.id, id))
        }
      } catch (err) {
        this.logger.error("Error syncing entitlements", {
          error: JSON.stringify(err),
        })

        tx.rollback()
        throw err
      }
    })

    return Ok(undefined)
  }

  public async getActivePhaseMachine({
    now,
  }: {
    now: number
  }): Promise<Result<PhaseMachine, UnPriceSubscriptionError>> {
    if (!this.initialized) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription phases not initialized, execute initPhaseMachines first",
        })
      )
    }

    // active phase is the one where now is between startAt and endAt
    const activePhase = Array.from(this.phases.values()).find((phase) => {
      return now >= phase.startAt && (phase.endAt ? now <= phase.endAt : true)
    })

    if (!activePhase) {
      return Err(
        new UnPriceSubscriptionError({
          message: "No active phase found",
        })
      )
    }

    if (!this.subscription || !this.customer) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription or customer not found",
        })
      )
    }

    const activePhaseMachine = new PhaseMachine({
      db: this.db,
      phase: activePhase,
      subscription: this.subscription,
      customer: this.customer,
      logger: this.logger,
      analytics: this.analytics,
    })

    return Ok(activePhaseMachine)
  }

  // creating a phase is a 2 step process:
  // 1. validate the input
  // 2. validate the subscription exists
  // 3. validate there is no active phase in the same start - end range for the subscription
  // 4. validate the config items are valid and there is no active subscription item in the same features
  // 5. create the phase
  // 6. create the items
  // 7. create entitlements
  public async createPhase({
    input,
    projectId,
    db,
    now,
  }: {
    input: InsertSubscriptionPhase
    projectId: string
    db?: Database | TransactionDatabase
    now: number
  }): Promise<Result<SubscriptionPhase, UnPriceSubscriptionError | SchemaError>> {
    const { success, data, error } = subscriptionPhaseInsertSchema.safeParse(input)

    if (!success) {
      return Err(SchemaError.fromZod(error, input))
    }

    const {
      planVersionId,
      trialDays,
      collectionMethod,
      startCycle,
      whenToBill,
      autoRenew,
      gracePeriod,
      metadata,
      config,
      paymentMethodId,
      startAt,
      endAt,
      dueBehaviour,
      subscriptionId,
    } = data

    const startAtToUse = startAt ?? now
    let endAtToUse = endAt ?? null

    // get subscription with phases from start date
    const subscriptionWithPhases = await (db ?? this.db).query.subscriptions.findFirst({
      where: (sub, { eq }) => eq(sub.id, subscriptionId),
      with: {
        phases: true,
      },
    })

    if (!subscriptionWithPhases) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription not found",
        })
      )
    }

    // don't allow to create phase when the subscription is not active
    if (!subscriptionWithPhases.active) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription is not active",
        })
      )
    }

    // order phases by startAt
    const orderedPhases = subscriptionWithPhases.phases.sort((a, b) => a.startAt - b.startAt)

    // active phase is the one where now is between startAt and endAt
    const activePhase = orderedPhases.find((phase) => {
      return startAtToUse >= phase.startAt && (phase.endAt ? startAtToUse <= phase.endAt : false)
    })

    if (activePhase) {
      return Err(
        new UnPriceSubscriptionError({
          message: "There is already an active phase in the same date range",
        })
      )
    }

    // verify phases don't overlap
    // start date of the new phase is greater than the end date of the phase
    // end date could be undefined or null which mean the phase is infinite
    // use reduce to check if there is any overlap
    const overlappingPhases = orderedPhases.some((p) => {
      return startAtToUse <= (p.endAt ?? Number.POSITIVE_INFINITY)
    })

    if (overlappingPhases) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phases overlap, there is already a phase in the same range",
        })
      )
    }

    // phase have to be consecutive with one another starting from the end date of the previous phase
    // use reduce to check if the phases are consecutive
    const consecutivePhases = orderedPhases.every((p, index) => {
      const previousPhase = orderedPhases[index - 1]

      if (previousPhase) {
        if (previousPhase.endAt) {
          return previousPhase.endAt + 1 === p.startAt
        }
      }

      return true
    })

    if (!consecutivePhases) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phases are not consecutive",
        })
      )
    }

    const versionData = await (db ?? this.db).query.versions.findFirst({
      with: {
        planFeatures: {
          with: {
            feature: true,
          },
        },
        plan: true,
        project: true,
      },
      where(fields, operators) {
        return operators.and(
          operators.eq(fields.id, planVersionId),
          operators.eq(fields.projectId, projectId)
        )
      },
    })

    if (!versionData?.id) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Version not found. Please check the planVersionId",
        })
      )
    }

    if (versionData.status !== "published") {
      return Err(
        new UnPriceSubscriptionError({
          message: "Plan version is not published, only published versions can be subscribed to",
        })
      )
    }

    if (versionData.active !== true) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Plan version is not active, only active versions can be subscribed to",
        })
      )
    }

    if (!versionData.planFeatures || versionData.planFeatures.length === 0) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Plan version has no features",
        })
      )
    }

    // if the customer has a default payment method, we use that
    // TODO: here it could be a problem, if the user sends a wrong payment method id, we will use the customer default payment method
    // for now just accept the default payment method is equal to the customer default payment method
    // but probably the best approach would be to use the payment method directly from the customer and don't have a default payment method in the subscription

    // check if payment method is required for the plan version
    const paymentMethodRequired = versionData.paymentMethodRequired
    const trialDaysToUse = trialDays ?? versionData.trialDays ?? 0

    // validate payment method if there is no trails
    if (trialDaysToUse === 0) {
      if (paymentMethodRequired && !paymentMethodId) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Payment method is required for this plan version",
          })
        )
      }
    }

    // check the subscription items configuration
    let configItemsSubscription: SubscriptionItemConfig[] = []

    if (!config) {
      // if no items are passed, configuration is created from the default quantities of the plan version
      const { err, val } = createDefaultSubscriptionConfig({
        planVersion: versionData,
      })

      if (err) {
        return Err(
          new UnPriceSubscriptionError({
            message: err.message,
          })
        )
      }

      configItemsSubscription = val
    } else {
      configItemsSubscription = config
    }

    // override the timezone with the project timezone and other defaults with the plan version data
    // only used for ui purposes all date are saved in utc
    const billingPeriod = versionData.billingPeriod
    const whenToBillToUse = whenToBill ?? versionData.whenToBill
    const collectionMethodToUse = collectionMethod ?? versionData.collectionMethod
    const startCycleToUse = startCycle ?? versionData.startCycle ?? 1

    // get the billing cycle for the subscription given the start date
    const calculatedBillingCycle = configureBillingCycleSubscription({
      currentCycleStartAt: startAtToUse,
      trialDays: trialDaysToUse,
      billingCycleStart: startCycleToUse,
      billingPeriod,
    })

    // if not auto renew we set end at to the end of the phase
    const autoRenewToUse = autoRenew ?? versionData.autoRenew ?? true

    if (!autoRenewToUse) {
      endAtToUse = calculatedBillingCycle.cycleEnd.getTime()
    }

    // calculate the next billing at given the when to bill
    const nextInvoiceAtToUse =
      whenToBillToUse === "pay_in_advance"
        ? calculatedBillingCycle.cycleStart.getTime()
        : calculatedBillingCycle.cycleEnd.getTime()

    const trialDaysEndAt = calculatedBillingCycle.trialDaysEndAt
      ? calculatedBillingCycle.trialDaysEndAt.getTime()
      : undefined

    const result = await (db ?? this.db).transaction(async (trx) => {
      // create the subscription phase
      const subscriptionPhase = await trx
        .insert(subscriptionPhases)
        .values({
          id: newId("subscription_phase"),
          projectId,
          planVersionId,
          subscriptionId,
          paymentMethodId,
          status: trialDaysToUse > 0 ? "trialing" : "active",
          trialEndsAt: trialDaysEndAt,
          trialDays: trialDaysToUse,
          startAt: startAtToUse,
          endAt: endAtToUse,
          collectionMethod: collectionMethodToUse,
          startCycle: startCycleToUse,
          dueBehaviour: dueBehaviour,
          whenToBill: whenToBillToUse,
          autoRenew: autoRenewToUse,
          gracePeriod,
          metadata,
          billingPeriod,
        })
        .returning()
        .catch((e) => {
          this.logger.error("Error creating subscription phase", {
            error: JSON.stringify(e),
          })
          throw e
        })
        .then((re) => re[0])

      if (!subscriptionPhase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Error while creating subscription phase",
          })
        )
      }

      if (!subscriptionWithPhases.active) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Subscription is not active",
          })
        )
      }

      // add items to the subscription
      await Promise.all(
        // this is important because every item has the configuration of the quantity of a feature in the subscription
        configItemsSubscription.map((item) =>
          trx.insert(subscriptionItems).values({
            id: newId("subscription_item"),
            subscriptionPhaseId: subscriptionPhase.id,
            projectId: projectId,
            featurePlanVersionId: item.featurePlanId,
            units: item.units,
          })
        )
      ).catch((e) => {
        this.logger.error("Error inserting subscription items", {
          error: JSON.stringify(e),
        })
        trx.rollback()
        throw e
      })

      // update the status of the subscription if the phase is active
      const isActivePhase =
        subscriptionPhase.startAt <= Date.now() &&
        (subscriptionPhase.endAt ?? Number.POSITIVE_INFINITY) >= Date.now()

      if (isActivePhase) {
        await trx
          .update(subscriptions)
          .set({
            active: true,
            // if there are trial days, we set the next invoice at to the end of the trial
            nextInvoiceAt:
              trialDaysToUse > 0 ? calculatedBillingCycle.cycleEnd.getTime() : nextInvoiceAtToUse,
            planSlug: versionData.plan.slug,
            currentCycleStartAt: calculatedBillingCycle.cycleStart.getTime(),
            currentCycleEndAt: calculatedBillingCycle.cycleEnd.getTime(),
            // if there is an end date, we set the expiration date
            expiresAt: endAtToUse,
          })
          .where(eq(subscriptions.id, subscriptionId))
      }

      // every time there is a new phase, we sync entitlements
      const syncEntitlementsResult = await this.syncEntitlementsForSubscription({
        projectId,
        customerId: subscriptionWithPhases.customerId,
        // we sync entitlements for the start date of the new phase
        // this will calculate the new entitlements for the phase
        // and add the end date to the entitlements that are no longer valid
        now: startAtToUse,
        db: trx,
        subscriptionId,
      })

      if (syncEntitlementsResult.err) {
        this.logger.error("Error syncing entitlements", {
          error: JSON.stringify(syncEntitlementsResult.err),
        })
        trx.rollback()
        throw syncEntitlementsResult.err
      }

      return Ok(subscriptionPhase)
    })

    return result
  }

  public async removePhase({
    phaseId,
    projectId,
    now,
  }: {
    phaseId: string
    projectId: string
    now: number
  }): Promise<Result<boolean, UnPriceSubscriptionError | SchemaError>> {
    // only allow that are not active
    // and are not in the past
    const phase = await this.db.query.subscriptionPhases.findFirst({
      where: (phase, { eq, and }) => and(eq(phase.id, phaseId), eq(phase.projectId, projectId)),
    })

    if (!phase) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase not found",
        })
      )
    }

    const isActivePhase = phase.startAt <= now && (phase.endAt ?? Number.POSITIVE_INFINITY) >= now
    const isInThePast = phase.startAt < now

    if (isActivePhase || isInThePast) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase is active or in the past, can't remove",
        })
      )
    }

    const result = await this.db.transaction(async (trx) => {
      // removing the phase will cascade to the subscription items and entitlements
      const subscriptionPhase = await trx
        .delete(subscriptionPhases)
        .where(and(eq(subscriptionPhases.id, phaseId), eq(subscriptionPhases.projectId, projectId)))
        .returning()
        .then((re) => re[0])

      if (!subscriptionPhase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Error while removing subscription phase",
          })
        )
      }

      return Ok(true)
    })

    return result
  }

  public async updatePhase({
    input,
    subscriptionId,
    projectId,
    db,
    now,
  }: {
    input: SubscriptionPhase
    subscriptionId: string
    projectId: string
    db?: Database | TransactionDatabase
    now: number
  }): Promise<Result<SubscriptionPhase, UnPriceSubscriptionError | SchemaError>> {
    const { success, data, error } = subscriptionPhaseSelectSchema.safeParse(input)

    if (!success) {
      return Err(SchemaError.fromZod(error, input))
    }

    const { startAt, endAt, items } = data

    // get subscription with phases from start date
    const subscriptionWithPhases = await (db ?? this.db).query.subscriptions.findFirst({
      where: (sub, { eq }) => eq(sub.id, subscriptionId),
      with: {
        phases: {
          where: (phase, { gte }) => gte(phase.startAt, startAt),
        },
      },
    })

    if (!subscriptionWithPhases) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription not found",
        })
      )
    }

    if (!subscriptionWithPhases.active) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription is not active",
        })
      )
    }

    // order phases by startAt
    const orderedPhases = subscriptionWithPhases.phases.sort((a, b) => a.startAt - b.startAt)

    const phaseToUpdate = orderedPhases.find((p) => p.id === input.id)

    if (!phaseToUpdate) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase not found",
        })
      )
    }

    // if this phase is active customer can't change the start date
    const isActivePhase =
      phaseToUpdate.startAt <= now && (phaseToUpdate.endAt ?? Number.POSITIVE_INFINITY) >= now

    if (isActivePhase && startAt !== phaseToUpdate.startAt) {
      return Err(
        new UnPriceSubscriptionError({
          message: "The phase is active, you can't change the start date",
        })
      )
    }

    // verify phases don't overlap result the phases that overlap
    const overlappingPhases = orderedPhases.filter((p) => {
      const startAtPhase = p.startAt
      const endAtPhase = p.endAt ?? Number.POSITIVE_INFINITY

      return (
        (startAtPhase < endAt! || startAtPhase === endAt!) &&
        (endAtPhase > startAt || endAtPhase === startAt)
      )
    })

    if (overlappingPhases.length > 0 && overlappingPhases.some((p) => p.id !== phaseToUpdate.id)) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phases overlap, there is already a phase in the same range",
        })
      )
    }

    // check if the phases are consecutive with one another starting from the end date of the previous phase
    // the phase that the customer is updating need to be check with the new dates
    const consecutivePhases = orderedPhases.filter((p, index) => {
      let phaseToCheck = p
      if (p.id === phaseToUpdate.id) {
        phaseToCheck = {
          ...p,
          startAt,
          endAt,
        }
      }

      if (index === 0) {
        return true
      }

      const previousPhase = orderedPhases[index - 1]
      return previousPhase ? previousPhase.endAt === phaseToCheck.startAt + 1 : false
    })

    if (consecutivePhases.length !== orderedPhases.length) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phases are not consecutive",
        })
      )
    }

    // validate the the end date is not less that the end date of the current billing cycle

    const currentCycleEndAt = subscriptionWithPhases.currentCycleEndAt

    if (endAt && endAt < currentCycleEndAt) {
      return Err(
        new UnPriceSubscriptionError({
          message: "The end date is less than the current billing cycle end date",
        })
      )
    }

    const result = await (db ?? this.db).transaction(async (trx) => {
      // create the subscription phase
      const subscriptionPhase = await trx
        .update(subscriptionPhases)
        .set({
          startAt: startAt,
          endAt: endAt ?? null,
        })
        .where(eq(subscriptionPhases.id, input.id))
        .returning()
        .then((re) => re[0])

      if (!subscriptionPhase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Error while updating subscription phase",
          })
        )
      }

      // add items to the subscription
      if (items?.length) {
        await Promise.all(
          // this is important because every item has the configuration of the quantity of a feature in the subscription
          items.map((item) =>
            trx
              .update(subscriptionItems)
              .set({
                units: item.units,
              })
              .where(eq(subscriptionItems.id, item.id))
          )
        ).catch((e) => {
          this.logger.error("Error inserting subscription items", {
            error: JSON.stringify(e),
          })
          trx.rollback()
          throw e
        })
      }

      // update the status of the subscription if the phase is active
      const isActivePhase =
        subscriptionPhase.startAt <= Date.now() &&
        (subscriptionPhase.endAt ?? Number.POSITIVE_INFINITY) >= Date.now()

      if (isActivePhase) {
        await trx
          .update(subscriptions)
          .set({
            expiresAt: endAt,
          })
          .where(eq(subscriptions.id, subscriptionId))
      }

      // every time there is a new phase, we sync entitlements
      const syncEntitlementsResult = await this.syncEntitlementsForSubscription({
        projectId,
        customerId: subscriptionWithPhases.customerId,
        // we sync entitlements for the start date of the new phase
        // this will calculate the new entitlements for the phase
        // and add the end date to the entitlements that are no longer valid
        now: subscriptionPhase.startAt,
        db: trx,
        subscriptionId,
      })

      if (syncEntitlementsResult.err) {
        this.logger.error("Error syncing entitlements", {
          error: JSON.stringify(syncEntitlementsResult.err),
        })
        trx.rollback()
        throw syncEntitlementsResult.err
      }

      return Ok(subscriptionPhase)
    })

    return result
  }

  // creating a subscription is a 4 step process:
  // 1. validate the input
  // 2. validate the customer exists
  // 3. create the subscription
  // 4. create the phases
  public async createSubscription({
    input,
    projectId,
  }: {
    input: InsertSubscription
    projectId: string
  }): Promise<Result<Subscription, UnPriceSubscriptionError | SchemaError>> {
    const { success, data, error } = subscriptionInsertSchema.safeParse(input)

    if (!success) {
      return Err(SchemaError.fromZod(error, input))
    }

    const { customerId, phases, metadata, timezone } = data

    const customerData = await this.db.query.customers.findFirst({
      with: {
        subscriptions: {
          // get active subscriptions of the customer
          where: (sub, { eq }) => eq(sub.active, true),
        },
        project: true,
      },
      where: (customer, operators) =>
        operators.and(
          operators.eq(customer.id, customerId),
          operators.eq(customer.projectId, projectId)
        ),
    })

    if (!customerData?.id) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Customer not found. Please check the customerId",
        })
      )
    }

    // if customer is not active, throw an error
    if (!customerData.active) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Customer is not active, please contact support",
        })
      )
    }

    // IMPORTANT: for now we only allow one subscription per customer
    if (customerData.subscriptions.length > 0) {
      return Err(
        new UnPriceSubscriptionError({
          message:
            "Customer already has a subscription, add a new phase to the existing subscription if you want to apply a change",
        })
      )
    }

    // project defaults
    const timezoneToUse = timezone || customerData.project.timezone

    // execute this in a transaction
    const result = await this.db.transaction(async (trx) => {
      try {
        // create the subscription
        const subscriptionId = newId("subscription")

        // create the subscription and then phases
        const newSubscription = await trx
          .insert(subscriptions)
          .values({
            id: subscriptionId,
            projectId,
            customerId: customerData.id,
            // create as pending, only when the first phase is created the subscription is active
            active: false,
            timezone: timezoneToUse,
            metadata: metadata,
            // provisional values
            nextInvoiceAt: Date.now(),
            currentCycleStartAt: Date.now(),
            currentCycleEndAt: Date.now(),
          })
          .returning()
          .then((re) => re[0])
          .catch((e) => {
            this.logger.error("Error creating subscription", {
              error: JSON.stringify(e),
            })
            trx.rollback()
            return null
          })

        if (!newSubscription) {
          return Err(
            new UnPriceSubscriptionError({
              message: "Error while creating subscription",
            })
          )
        }

        // create the phases
        await Promise.all(
          phases.map((phase) =>
            this.createPhase({
              input: {
                ...phase,
                subscriptionId: newSubscription.id,
              },
              projectId,
              db: trx,
              now: Date.now(),
            })
          )
        ).catch((e) => {
          this.logger.error("Error creating subscription phases", {
            error: JSON.stringify(e),
          })

          trx.rollback()
          throw e
        })

        return Ok(newSubscription)
      } catch (e) {
        this.logger.error("Error creating subscription", {
          error: JSON.stringify(e),
        })

        trx.rollback()
        throw e
      }
    })

    if (result.err) {
      return Err(result.err)
    }

    const customerService = new CustomerService({
      cache: this.cache,
      db: this.db,
      analytics: this.analytics,
      logger: this.logger,
      metrics: this.metrics,
      waitUntil: this.waitUntil,
    })

    // once the subscription is created, we can update the cache
    this.waitUntil(
      customerService.updateCacheAllCustomerEntitlementsByDate({
        customerId,
        projectId,
        date: Date.now(),
      })
    )

    const subscription = result.val

    return Ok(subscription)
  }

  public async renewSubscription(payload: { now: number }): Promise<
    Result<{ phaseStatus: PhaseStatus; activePhaseId: string }, UnPriceSubscriptionError>
  > {
    const { now } = payload
    const { err, val: activePhaseMachine } = await this.getActivePhaseMachine({
      now,
    })

    if (err) {
      return Err(err)
    }

    const activePhase = activePhaseMachine.getPhase()

    const { err: renewErr, val: renew } = await activePhaseMachine.transition("RENEW", {
      now,
    })

    if (renewErr) {
      return Err(renewErr)
    }

    return Ok({
      phaseStatus: renew.status,
      activePhaseId: activePhase.id,
    })
  }

  // apply a change to the subscription, the new subscription phase should be created
  public async expireSubscription(payload: {
    expiresAt?: number
    now: number
    metadata?: SubscriptionPhaseMetadata
  }): Promise<Result<{ status: PhaseStatus }, UnPriceSubscriptionError>> {
    const { expiresAt, now, metadata } = payload

    const { err, val: activePhaseMachine } = await this.getActivePhaseMachine({
      now,
    })

    if (err) {
      return Err(err)
    }

    const { err: expireErr, val: expire } = await activePhaseMachine.transition("EXPIRE", {
      expiresAt,
      now,
      metadata,
    })

    if (expireErr) {
      return Err(expireErr)
    }

    return Ok({
      status: expire.status,
    })
  }

  public async invoiceSubscription(payload: { now: number }): Promise<
    Result<
      { invoiceId: string; phaseStatus: PhaseStatus; activePhaseId: string },
      UnPriceSubscriptionError
    >
  > {
    const { now } = payload

    const { err, val: activePhaseMachine } = await this.getActivePhaseMachine({
      now,
    })

    if (err) {
      return Err(err)
    }

    const activePhase = activePhaseMachine.getPhase()

    const { err: invoiceErr, val: invoiceResult } = await activePhaseMachine.transition("INVOICE", {
      now,
    })

    if (invoiceErr) {
      return Err(invoiceErr)
    }

    return Ok({
      invoiceId: invoiceResult.invoice.id,
      phaseStatus: invoiceResult.status,
      activePhaseId: activePhase.id,
    })
  }

  // apply a change to the subscription, the new subscription phase should be created
  public async cancelSubscription(payload: {
    cancelAt?: number
    now: number
    metadata?: SubscriptionPhaseMetadata
  }): Promise<
    Result<{ phaseStatus: PhaseStatus; activePhaseId: string }, UnPriceSubscriptionError>
  > {
    const { cancelAt, now, metadata } = payload

    const { err, val: activePhaseMachine } = await this.getActivePhaseMachine({
      now,
    })

    if (err) {
      return Err(err)
    }

    const activePhase = activePhaseMachine.getPhase()

    const { err: cancelErr, val: cancel } = await activePhaseMachine.transition("CANCEL", {
      cancelAt,
      now,
      metadata,
    })

    if (cancelErr) {
      return Err(cancelErr)
    }

    return Ok({
      phaseStatus: cancel.status,
      activePhaseId: activePhase.id,
    })
  }

  // when an invoice is past due we need to mark the subscription as past due
  public async pastDueSubscription(payload: {
    now: number
    pastDueAt?: number
    phaseId: string
    invoiceId: string
    metadata?: SubscriptionPhaseMetadata
  }): Promise<Result<void, UnPriceSubscriptionError>> {
    const { now, pastDueAt, phaseId, invoiceId, metadata } = payload

    // the phase that trigger the past due don't necessarily have to be the active phase
    // for instance if the subscription is past due because of a previous phase we need to mark it as past due
    // for this we need to get the machine of that phase.

    const phase = this.phases.get(phaseId)

    if (!phase) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase not found",
        })
      )
    }

    const invoice = await this.db.query.invoices.findFirst({
      where: (inv, { eq, and }) => and(eq(inv.id, invoiceId), eq(inv.subscriptionPhaseId, phaseId)),
    })

    if (!invoice) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Invoice not found",
        })
      )
    }

    if (["paid", "void"].includes(invoice.status)) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Invoice is not past due, it has been already paid or voided",
        })
      )
    }

    if (!this.subscription || !this.customer) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription or customer not found",
        })
      )
    }

    const phaseMachine = new PhaseMachine({
      db: this.db,
      phase,
      logger: this.logger,
      subscription: this.subscription,
      customer: this.customer,
      analytics: this.analytics,
    })

    const { err: pastDueErr } = await phaseMachine.transition("PAST_DUE", {
      now,
      pastDueAt,
      metadata,
    })

    if (pastDueErr) {
      return Err(pastDueErr)
    }

    return Ok(undefined)
  }

  // change subscription implies creating a new phase and ending the current one
  // for the current phase we need to prorate open invoices, create a new invoice and collect payment
  // after that we can create the new phase
  public async changeSubscription(payload: {
    now: number
    newPhase?: InsertSubscriptionPhase
    changeAt?: number
    metadata?: SubscriptionPhaseMetadata
  }): Promise<
    Result<
      {
        oldPhaseStatus: PhaseStatus
        newPhaseStatus: PhaseStatus
        activePhaseId: string
        newPhaseId: string
      },
      UnPriceSubscriptionError
    >
  > {
    const { now, newPhase, changeAt, metadata } = payload

    const { err, val: activePhaseMachine } = await this.getActivePhaseMachine({
      now,
    })

    if (err) {
      return Err(err)
    }

    const activePhase = activePhaseMachine.getPhase()

    const { err: changeErr, val: change } = await activePhaseMachine.transition("CHANGE", {
      now,
      changeAt,
      metadata,
    })

    if (changeErr) {
      return Err(changeErr)
    }

    // if a new phase is provided we need to create it
    if (newPhase) {
      // if all goes well we create the new phase
      const { err: createPhaseErr, val: newPhaseResult } = await this.createPhase({
        input: {
          ...newPhase,
          startAt: change.changedAt, // we need to start the new phase at the next millisecond
          subscriptionId: activePhase.subscriptionId,
        },
        projectId: activePhase.projectId,
        db: this.db,
        now,
      })

      if (createPhaseErr) {
        return Err(
          new UnPriceSubscriptionError({
            message: `Error while creating new phase: ${createPhaseErr.message}`,
          })
        )
      }

      return Ok({
        oldPhaseStatus: change.status,
        newPhaseStatus: newPhaseResult.status,
        activePhaseId: activePhase.id,
        newPhaseId: newPhaseResult.id,
      })
    }

    return Ok({
      oldPhaseStatus: change.status,
      newPhaseStatus: change.status,
      activePhaseId: activePhase.id,
      newPhaseId: activePhase.id,
    })
  }

  // end trial is a 3 step process:
  // 1. end trial
  // 2. invoice (if billed in advance)
  // 3. collect payment (if billed in advance)
  public async endSubscriptionTrial(payload: { now: number }): Promise<
    Result<
      {
        phaseStatus: PhaseStatus
        invoiceId?: string
        total?: number
        paymentInvoiceId?: string
        activePhaseId: string
      },
      UnPriceSubscriptionError
    >
  > {
    const { now } = payload
    const { err, val: activePhaseMachine } = await this.getActivePhaseMachine({
      now,
    })

    if (err) {
      return Err(err)
    }

    const activePhase = activePhaseMachine.getPhase()

    // 1. end trial
    // this will renew the subscription dates and set the trial_ended status
    const { err: endTrialErr, val: endTrialVal } = await activePhaseMachine.transition(
      "END_TRIAL",
      {
        now,
      }
    )

    // UnPriceMachineError is expected if the machine is in a state that does not allow the transition
    // which means the process failed at some point and we need to retry
    if (endTrialErr && !(endTrialErr instanceof UnPriceMachineError)) {
      return Err(endTrialErr)
    }

    const status = endTrialVal?.status ?? activePhase.status
    const whenToBill = activePhase.whenToBill

    // invoice right away if the subscription is billed in advance
    if (whenToBill === "pay_in_advance") {
      // 2. create invoice (if billed in advance)
      const { err: invoiceErr, val: invoice } = await activePhaseMachine.transition("INVOICE", {
        now,
      })

      if (invoiceErr && !(invoiceErr instanceof UnPriceMachineError)) {
        return Err(invoiceErr)
      }

      const invoiceMachine = new InvoiceStateMachine({
        db: this.db,
        phaseMachine: activePhaseMachine,
        logger: this.logger,
        analytics: this.analytics,
        invoice: invoice?.invoice!,
      })

      // 3. collect payment (if billed in advance)
      const payment = await invoiceMachine.transition("COLLECT_PAYMENT", {
        invoiceId: invoice?.invoice.id!,
        now,
        autoFinalize: true,
      })

      if (payment.err && !(payment.err instanceof UnPriceMachineError)) {
        return Err(payment.err)
      }

      const { invoiceId, retries, total, paymentInvoiceId } = payment.val!

      return Ok({
        phaseStatus: activePhase.status,
        invoiceId,
        total,
        paymentInvoiceId,
        retries,
        activePhaseId: activePhase.id,
      })
    }

    // if the subscription is not billed in advance, we just return the status of the end trial
    return Ok({
      phaseStatus: status,
      activePhaseId: activePhase.id,
    })
  }
}