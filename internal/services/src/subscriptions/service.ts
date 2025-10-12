import type { Analytics } from "@unprice/analytics"
import { type Database, type SQL, and, eq, inArray, sql } from "@unprice/db"
import {
  customerEntitlements,
  subscriptionItems,
  subscriptionPhases,
  subscriptions,
} from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
  type InsertSubscription,
  type InsertSubscriptionPhase,
  type Subscription,
  type SubscriptionItemConfig,
  type SubscriptionPhase,
  calculateCycleWindow,
  calculateDateAt,
  createDefaultSubscriptionConfig,
  getAnchor,
} from "@unprice/db/validators"
import { Err, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type { Cache } from "../cache"
import { CustomerService } from "../customers/service"
import type { Metrics } from "../metrics"
import { UnPriceSubscriptionError } from "./errors"
import { SubscriptionMachine } from "./machine"
import { SubscriptionLock } from "./subscriptionLock"
import type { SusbriptionMachineStatus } from "./types"

export class SubscriptionService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private customerService: CustomerService

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
  }

  // create the entitlements for the new phase
  public async createEntitlementsForPhase({
    phaseId,
    projectId,
    customerId,
    db,
  }: {
    phaseId: string
    projectId: string
    customerId: string
    db?: Database
  }): Promise<Result<void, UnPriceSubscriptionError>> {
    // get the active phase for the subscription with the customer entitlements
    const phase = await (db ?? this.db).query.subscriptionPhases.findFirst({
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
      where: (phase, { eq, and }) => and(eq(phase.id, phaseId), eq(phase.projectId, projectId)),
    })

    if (!phase) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase not found",
        })
      )
    }

    const { items, ...phaseData } = phase

    await (db ?? this.db)
      .insert(customerEntitlements)
      .values(
        items.map((item) => ({
          id: newId("customer_entitlement"),
          projectId,
          customerId,
          subscriptionId: phaseData.subscriptionId,
          featurePlanVersionId: item.featurePlanVersionId,
          subscriptionItemId: item.id,
          units: item.units,
          usage: "0",
          accumulatedUsage: "0",
          // if there are defined units thats the limit
          limit: item.units ?? item.featurePlanVersion.limit,
          subscriptionPhaseId: phaseData.id,
          validFrom: phaseData.startAt,
          validTo: phaseData.endAt,
          resetedAt: Date.now(),
          active: true,
          isCustom: false,
          lastUsageUpdateAt: Date.now(),
        }))
      )
      .catch((e) => {
        this.logger.error(e.message)
        throw new UnPriceSubscriptionError({
          message: `Error while creating customer entitlements: ${e.message}`,
        })
      })

    return Ok(undefined)
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
    db?: Database
    now: number
  }): Promise<Result<SubscriptionPhase, UnPriceSubscriptionError | SchemaError>> {
    const {
      planVersionId,
      trialUnits,
      metadata,
      config,
      paymentMethodId,
      startAt,
      endAt,
      subscriptionId,
    } = input

    const startAtToUse = startAt ?? now
    const endAtToUse = endAt ?? undefined

    // if the end date is in the past, set it to the current date
    if (endAtToUse && endAtToUse < now) {
      return Err(
        new UnPriceSubscriptionError({
          message: "End date is in the past",
        })
      )
    }

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
    if (!subscriptionWithPhases.active && subscriptionWithPhases.status !== "active") {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription must be active to create a new phase. Please contact support.",
        })
      )
    }

    // validate if the phase is already in the subscription
    // the same plan version and start and end date
    // this makes this function idempotent
    const phaseAlreadyInSubscription = subscriptionWithPhases.phases.find((p) => {
      return (
        p.planVersionId === planVersionId &&
        p.startAt <= startAtToUse &&
        (p.endAt === endAtToUse || p.endAt === null)
      )
    })

    if (phaseAlreadyInSubscription) {
      return Ok(phaseAlreadyInSubscription)
    }

    // order phases by startAt
    const orderedPhases = subscriptionWithPhases.phases.sort((a, b) => a.startAt - b.startAt)

    // active phase is the one where now is between startAt and endAt or endAt is undefined
    const activePhase = orderedPhases.find((phase) => {
      return startAtToUse >= phase.startAt && (phase.endAt ? startAtToUse <= phase.endAt : true)
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
    // end date could be undefined or null which mean the phase is open ended
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
    const consecutivePhases = orderedPhases.every((p, index) => {
      const previousPhase = orderedPhases[index - 1]

      if (previousPhase) {
        if (previousPhase.endAt) {
          // every phase end we add 1 millisecond to the end date
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

    // check if payment method is required for the plan version
    const paymentMethodRequired = versionData.paymentMethodRequired
    const trialUnitsToUse = trialUnits ?? versionData.trialUnits ?? 0
    const billingAnchorToUse = getAnchor(
      startAtToUse,
      versionData.billingConfig.billingInterval,
      versionData.billingConfig.billingAnchor
    )
    // const billingIntervalToUse = versionData.billingConfig.billingInterval
    // const subscriptionTimezone = subscriptionWithPhases.timezone

    // calculate the day of creation of the subscription
    // important to keep in mind the timezone of the project
    // if (billingAnchorToUse === "dayOfCreation") {
    //   billingAnchorToUse = getDate(toZonedTime(startAtToUse, subscriptionTimezone))
    // }

    // validate payment method is required and if not provided
    if (paymentMethodRequired && (!paymentMethodId || paymentMethodId === "")) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Payment method is required for this plan version",
        })
      )
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

    const trialsEndAt =
      trialUnitsToUse > 0
        ? calculateDateAt({
            startDate: startAtToUse,
            config: {
              interval: versionData.billingConfig.billingInterval,
              units: trialUnitsToUse,
            },
          })
        : null

    // get the billing cycle for the subscription given the start date
    const calculatedBillingCycle = calculateCycleWindow({
      effectiveStartDate: startAtToUse,
      effectiveEndDate: endAtToUse ?? null,
      trialEndsAt: trialsEndAt,
      now: startAtToUse, // we use the start date to calculate the billing cycle
      billingConfig: versionData.billingConfig,
    })

    if (!calculatedBillingCycle) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Failed to calculate billing cycle",
        })
      )
    }

    const result = await (db ?? this.db).transaction(async (trx) => {
      // create the subscription phase
      const phase = await trx
        .insert(subscriptionPhases)
        .values({
          id: newId("subscription_phase"),
          projectId,
          planVersionId,
          subscriptionId,
          paymentMethodId,
          trialEndsAt: trialsEndAt,
          trialUnits: trialUnitsToUse,
          startAt: startAtToUse,
          endAt: endAtToUse,
          metadata,
          billingAnchor: billingAnchorToUse ?? 0,
        })
        .returning()
        .catch((e) => {
          this.logger.error(e.message)
          throw e
        })
        .then((re) => re[0])

      if (!phase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Error while creating subscription phase",
          })
        )
      }

      // add items to the subscription
      await Promise.all(
        // this is important because every item has the configuration of the quantity of a feature in the subscription
        configItemsSubscription.map((item) =>
          trx.insert(subscriptionItems).values({
            id: newId("subscription_item"),
            subscriptionPhaseId: phase.id,
            projectId: projectId,
            featurePlanVersionId: item.featurePlanId,
            units: item.units,
            subscriptionId,
          })
        )
      ).catch((e) => {
        this.logger.error(e.message)
        trx.rollback()
        throw e
      })

      // update the status of the subscription if the phase is active
      const isActivePhase =
        phase.startAt <= Date.now() && (phase.endAt ?? Number.POSITIVE_INFINITY) >= Date.now()

      if (isActivePhase) {
        await trx
          .update(subscriptions)
          .set({
            active: true,
            status: Number(trialUnitsToUse) > 0 ? "trialing" : "active",
            planSlug: versionData.plan.slug,
            currentCycleStartAt: calculatedBillingCycle.start,
            currentCycleEndAt: calculatedBillingCycle.end,
            renewAt: calculatedBillingCycle.start, // we schedule the renewal for the start of the cycle always
          })
          .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.projectId, projectId)))
      }

      // we create the entitlements for the new phase
      const createEntitlementsResult = await this.createEntitlementsForPhase({
        phaseId: phase.id,
        projectId,
        customerId: subscriptionWithPhases.customerId,
        db: trx,
      })

      if (createEntitlementsResult.err) {
        this.logger.error(createEntitlementsResult.err.message)
        trx.rollback()
        throw createEntitlementsResult.err
      }

      return Ok(phase)
    })

    // generate the billing periods for the new phase on background
    // this can fail but background jobs can retry
    // TODO: generate the billing periods for the new phase on background

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
    db?: Database
    now: number
  }): Promise<Result<SubscriptionPhase, UnPriceSubscriptionError | SchemaError>> {
    const { startAt, endAt, items } = input

    let endAtToUse = endAt ?? undefined

    // TODO: check this
    // if the end date is in the past, set it to the current date
    if (endAt && endAt < now) {
      endAtToUse = now
    }

    // get subscription with phases from start date
    const subscriptionWithPhases = await (db ?? this.db).query.subscriptions.findFirst({
      where: (sub, { eq, and }) => and(eq(sub.id, subscriptionId), eq(sub.projectId, projectId)),
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
        (startAtPhase < endAtToUse! || startAtPhase === endAtToUse!) &&
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
          endAt: endAtToUse ?? null,
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
          message: `The end date is less than the current billing cycle end date, set a date greater than ${new Date(currentCycleEndAt).toISOString()}`,
        })
      )
    }

    const result = await (db ?? this.db).transaction(async (trx) => {
      // create the subscription phase
      const subscriptionPhase = await trx
        .update(subscriptionPhases)
        .set({
          startAt: startAt,
          endAt: endAtToUse ?? null,
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
        const sqlChunksItems: SQL[] = []
        const sqlChunksEntitlements: SQL[] = []

        const ids: string[] = []
        sqlChunksItems.push(sql`(case`)
        sqlChunksEntitlements.push(sql`(case`)

        for (const item of items) {
          sqlChunksItems.push(
            item.units === null
              ? sql`when ${subscriptionItems.id} = ${item.id} then NULL`
              : sql`when ${subscriptionItems.id} = ${item.id} then cast(${item.units} as int)`
          )
          sqlChunksEntitlements.push(
            item.units === null
              ? sql`when ${customerEntitlements.subscriptionItemId} = ${item.id} then NULL`
              : sql`when ${customerEntitlements.subscriptionItemId} = ${item.id} then cast(${item.units} as int)`
          )
          ids.push(item.id)
        }

        sqlChunksItems.push(sql`end)`)
        sqlChunksEntitlements.push(sql`end)`)

        const finalSqlItems: SQL = sql.join(sqlChunksItems, sql.raw(" "))
        const finalSqlEntitlements: SQL = sql.join(sqlChunksEntitlements, sql.raw(" "))

        await (db ?? this.db)
          .update(subscriptionItems)
          .set({ units: finalSqlItems })
          .where(
            and(inArray(subscriptionItems.id, ids), eq(subscriptionItems.projectId, projectId))
          )
          .catch((e) => {
            this.logger.error(e.message)
            throw new UnPriceSubscriptionError({
              message: `Error while updating subscription items: ${e.message}`,
            })
          })

        // update the units for the entitlements
        await (db ?? this.db)
          .update(customerEntitlements)
          .set({ units: finalSqlEntitlements })
          .where(inArray(customerEntitlements.subscriptionItemId, ids))
          .catch((e) => {
            this.logger.error(e.message)
            throw new UnPriceSubscriptionError({
              message: `Error while updating customer entitlements: ${e.message}`,
            })
          })
      }

      return Ok(subscriptionPhase)
    })

    return result
  }

  public async createSubscription({
    input,
    projectId,
  }: {
    input: Omit<InsertSubscription, "phases">
    projectId: string
  }): Promise<Result<Subscription, UnPriceSubscriptionError | SchemaError>> {
    const { customerId, metadata, timezone } = input

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
          message: "Customer is not active",
        })
      )
    }

    // IMPORTANT: for now we only allow one subscription per customer
    if (customerData.subscriptions.length > 0) {
      return Ok(customerData.subscriptions[0]!)
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
            active: false,
            status: "active",
            timezone: timezoneToUse,
            metadata: metadata,
            // provisional values
            currentCycleStartAt: Date.now(),
            currentCycleEndAt: Date.now(),
          })
          .returning()
          .then((re) => re[0])
          .catch((e) => {
            this.logger.error(e.message)
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

        return Ok(newSubscription)
      } catch (e) {
        this.logger.error("Error creating subscription", {
          error: JSON.stringify(e),
        })

        trx.rollback()
        throw e // this is never reach because rollback will throw an error
      }
    })

    if (result.err) {
      return Err(result.err)
    }

    const subscription = result.val

    return Ok(subscription)
  }

  public async getSubscriptionData({
    subscriptionId,
    projectId,
  }: {
    subscriptionId: string
    projectId: string
  }): Promise<Subscription | null> {
    const subscriptionData = await this.db.query.subscriptions.findFirst({
      with: {
        project: true,
      },
      where: (subscription, operators) =>
        operators.and(
          operators.eq(subscription.id, subscriptionId),
          operators.eq(subscription.projectId, projectId)
        ),
    })

    if (!subscriptionData?.id) {
      return null
    }

    return subscriptionData
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
      if (!acquired) throw new UnPriceSubscriptionError({ message: "SUBSCRIPTION_BUSY" })
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

  public async renewSubscription({
    subscriptionId,
    projectId,
    now = Date.now(),
  }: {
    subscriptionId: string
    projectId: string
    now?: number
  }): Promise<Result<{ status: SusbriptionMachineStatus }, UnPriceSubscriptionError>> {
    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        run: async (machine) => {
          const s1 = await machine.renew()
          if (s1.err) throw s1.err
          return s1.val
        },
      })
      return Ok({ status })
    } catch (e) {
      return Err(e as UnPriceSubscriptionError)
    }
  }

  public async invoiceSubscription({
    subscriptionId,
    projectId,
    now = Date.now(),
  }: {
    subscriptionId: string
    projectId: string
    now?: number
  }): Promise<
    Result<
      {
        status: SusbriptionMachineStatus
      },
      UnPriceSubscriptionError
    >
  > {
    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: true, // we need to lock the subscription to avoid cross-worker races
        run: async (machine) => {
          const i = await machine.invoice()
          if (i.err) throw i.err
          return i.val
        },
      })
      return Ok({ status })
    } catch (e) {
      return Err(e as UnPriceSubscriptionError)
    }
  }
}
