import { type Database, type TransactionDatabase, and, eq } from "@unprice/db"

import { customerEntitlements, customerSessions, customers } from "@unprice/db/schema"
import { AesGCM, newId } from "@unprice/db/utils"
import type { CustomerEntitlement, CustomerSignUp, FeatureType } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type { Analytics } from "@unprice/tinybird"
import type { Cache, CacheNamespaces } from "../cache"
import { env } from "../env.mjs"
import type { Metrics } from "../metrics"
import { PaymentProviderService } from "../payment-provider"
import { SubscriptionService } from "../subscriptions"
import type { DenyReason } from "./errors"
import { UnPriceCustomerError } from "./errors"
import { getEntitlementByDateQuery, getEntitlementsByDateQuery } from "./queries"

export class CustomerService {
  private readonly cache: Cache | undefined
  private readonly db: Database | TransactionDatabase
  private readonly metrics: Metrics
  private readonly logger: Logger
  private readonly waitUntil: (p: Promise<unknown>) => void
  private readonly analytics: Analytics

  constructor(opts: {
    cache: Cache | undefined
    metrics: Metrics
    db: Database | TransactionDatabase
    analytics: Analytics
    logger: Logger
    waitUntil: (p: Promise<unknown>) => void
  }) {
    this.cache = opts.cache
    this.db = opts.db
    this.metrics = opts.metrics
    this.analytics = opts.analytics
    this.logger = opts.logger
    this.waitUntil = opts.waitUntil
  }

  private async _getCustomerEntitlementByDate(opts: {
    customerId: string
    projectId: string
    featureSlug: string
    date: number
  }): Promise<
    Result<
      Omit<CustomerEntitlement, "createdAtM" | "updatedAtM">,
      UnPriceCustomerError | FetchError
    >
  > {
    // if not cache then retrive from database
    if (!this.cache) {
      const entitlement = await getEntitlementByDateQuery({
        customerId: opts.customerId,
        projectId: opts.projectId,
        db: this.db,
        metrics: this.metrics,
        logger: this.logger,
        date: opts.date,
        featureSlug: opts.featureSlug,
      })

      if (!entitlement) {
        return Err(
          new UnPriceCustomerError({
            code: "FEATURE_OR_CUSTOMER_NOT_FOUND",
            customerId: opts.customerId,
          })
        )
      }

      return Ok(entitlement)
    }

    const res = await this.cache.featureByCustomerId.swr(
      `${opts.customerId}:${opts.featureSlug}`,
      async () => {
        return await getEntitlementByDateQuery({
          customerId: opts.customerId,
          projectId: opts.projectId,
          db: this.db,
          metrics: this.metrics,
          logger: this.logger,
          date: opts.date,
          featureSlug: opts.featureSlug,
        })
      }
    )

    if (res.err) {
      this.logger.error(`Error in _getCustomerEntitlementByDate: ${res.err.message}`, {
        error: JSON.stringify(res.err),
        customerId: opts.customerId,
        featureSlug: opts.featureSlug,
        projectId: opts.projectId,
      })

      return Err(
        new FetchError({
          message: "unable to fetch required data",
          retry: true,
          cause: res.err,
        })
      )
    }

    // cache miss, get from db
    if (!res.val) {
      const entitlement = await getEntitlementByDateQuery({
        customerId: opts.customerId,
        projectId: opts.projectId,
        db: this.db,
        metrics: this.metrics,
        logger: this.logger,
        date: opts.date,
        featureSlug: opts.featureSlug,
      })

      if (!entitlement) {
        return Err(
          new UnPriceCustomerError({
            code: "FEATURE_OR_CUSTOMER_NOT_FOUND",
            customerId: opts.customerId,
          })
        )
      }

      return Ok(entitlement)
    }

    return Ok(res.val)
  }

  public async updateCacheAllCustomerEntitlementsByDate({
    customerId,
    projectId,
    date,
  }: {
    customerId: string
    projectId: string
    date: number
  }) {
    if (!this.cache) {
      return
    }

    // update the cache
    await getEntitlementsByDateQuery({
      customerId,
      projectId,
      db: this.db,
      metrics: this.metrics,
      date,
      logger: this.logger,
      includeCustom: true,
    }).then(async (activeEntitlements) => {
      if (activeEntitlements.length === 0) {
        return
      }

      return Promise.all([
        // save the customer entitlements
        // this.cache.entitlementsByCustomerId.set(
        //   subscriptionData.customerId,
        //   customerEntitlements
        // ),
        // save features

        // we nned to think about the best way to cache the features
        activeEntitlements.map((item) => {
          return this.cache?.featureByCustomerId.set(`${customerId}:${item.featureSlug}`, item)
        }),
      ])
    })
  }

  public async updateEntitlementsUsage(opts: {
    customerId: string
    projectId: string
    date: number
  }) {
    // get active entitlements from the db
    const entitlements = await getEntitlementsByDateQuery({
      customerId: opts.customerId,
      projectId: opts.projectId,
      db: this.db,
      metrics: this.metrics,
      logger: this.logger,
      date: opts.date,
      includeCustom: true,
    })

    // we need to get the current subscription

    await Promise.all(
      entitlements.map(async (entitlement) => {
        // get usage for the period from the analytics service
        const totalUsage = await this.analytics.getTotalUsagePerCustomer({
          customerId: opts.customerId,
          projectId: opts.projectId,
          subscriptionId: entitlement.subscriptionItem?.subscriptionPhase?.subscription?.id!,
          start:
            entitlement.subscriptionItem?.subscriptionPhase?.subscription?.currentCycleStartAt!,
          end: entitlement.subscriptionItem?.subscriptionPhase?.subscription?.currentCycleEndAt!,
        })

        const feature = totalUsage.data.find((u) => u.featureSlug === entitlement.featureSlug)
        const usage = feature?.[entitlement.aggregationMethod]

        // if the usage is not found, then do nothing
        // no need to log an error here because could be the case that there is not usage reported yet yet
        if (!usage) {
          return
        }

        // update the usage of the entitlement
        await this.db
          .update(customerEntitlements)
          .set({
            usage: usage,
            lastUsageUpdateAt: Date.now(),
          })
          .where(
            and(
              eq(customerEntitlements.id, entitlement.id),
              eq(customerEntitlements.projectId, opts.projectId)
            )
          )
      })
    )
  }

  public async getEntitlementsByDate(opts: {
    customerId: string
    projectId: string
    date: number
    includeCustom?: boolean
    noCache?: boolean
    updateUsage?: boolean
  }): Promise<
    Result<CacheNamespaces["entitlementsByCustomerId"], UnPriceCustomerError | FetchError>
  > {
    if (opts.noCache || !this.cache) {
      if (opts.updateUsage) {
        await this.updateEntitlementsUsage({
          customerId: opts.customerId,
          projectId: opts.projectId,
          date: opts.date,
        })
      }

      const entitlements = await getEntitlementsByDateQuery({
        customerId: opts.customerId,
        projectId: opts.projectId,
        db: this.db,
        metrics: this.metrics,
        logger: this.logger,
        date: opts.date,
        includeCustom: opts.includeCustom,
      })

      return Ok(entitlements)
    }

    const res = await this.cache.entitlementsByCustomerId.swr(opts.customerId, async () => {
      // updating the usage from the analytics service first and then updating the cache
      // TODO: mesure the performance of this
      if (opts.updateUsage) {
        await this.updateEntitlementsUsage({
          customerId: opts.customerId,
          projectId: opts.projectId,
          date: opts.date,
        })
      }

      return await getEntitlementsByDateQuery({
        customerId: opts.customerId,
        projectId: opts.projectId,
        db: this.db,
        metrics: this.metrics,
        date: opts.date,
        logger: this.logger,
        includeCustom: opts.includeCustom,
      })
    })

    if (res.err) {
      this.logger.error("unable to fetch entitlements", {
        error: JSON.stringify(res.err),
        customerId: opts.customerId,
        projectId: opts.projectId,
      })

      return Err(
        new FetchError({
          message: "unable to fetch required data",
          retry: true,
          cause: res.err,
        })
      )
    }

    if (res.val && res.val.length > 0) {
      // filter out to get only the active entitlements
      return Ok(
        res.val.filter((ent) => {
          // an entitlement is active if it's between startAt and endAt
          // end date could be null, so it's active until the end of time
          return ent.startAt <= opts.date && (ent.endAt ? ent.endAt >= opts.date : true)
        })
      )
    }

    // cache miss, get from db
    const entitlements = await getEntitlementsByDateQuery({
      customerId: opts.customerId,
      projectId: opts.projectId,
      db: this.db,
      metrics: this.metrics,
      logger: this.logger,
      date: opts.date,
      includeCustom: opts.includeCustom,
    })

    // cache the active entitlements
    this.waitUntil(this.cache.entitlementsByCustomerId.set(opts.customerId, entitlements))

    return Ok(entitlements)
  }

  public async verifyEntitlement(opts: {
    customerId: string
    featureSlug: string
    projectId: string
    date: number
  }): Promise<
    Result<
      {
        access: boolean
        currentUsage?: number
        limit?: number
        deniedReason?: DenyReason
        remaining?: number
        featureType?: FeatureType
        units?: number
      },
      UnPriceCustomerError | FetchError
    >
  > {
    try {
      const { customerId, projectId, featureSlug, date } = opts
      const start = performance.now()

      // TODO: should I validate if the subscription is active?
      // TODO: should I validate if the customer is active?

      const res = await this._getCustomerEntitlementByDate({
        customerId,
        projectId,
        featureSlug,
        date,
      })

      if (res.err) {
        const error = res.err

        this.logger.error("Error in ve", {
          error: JSON.stringify(error),
          customerId: opts.customerId,
          featureSlug: opts.featureSlug,
          projectId: opts.projectId,
        })

        switch (true) {
          case error instanceof UnPriceCustomerError: {
            // we should return a response with the denied reason in this case
            if (error.code === "FEATURE_NOT_FOUND_IN_SUBSCRIPTION") {
              return Ok({
                access: false,
                deniedReason: "FEATURE_NOT_FOUND_IN_SUBSCRIPTION",
              })
            }

            return res
          }

          default:
            return res
        }
      }

      const entitlement = res.val

      const analyticsPayload = {
        projectId: entitlement.projectId,
        planVersionFeatureId: entitlement.featurePlanVersionId,
        subscriptionItemId: entitlement.subscriptionItemId,
        entitlementId: entitlement.id,
        featureSlug: featureSlug,
        customerId: customerId,
        date: Date.now(),
      }

      switch (entitlement.featureType) {
        case "flat": {
          // flat feature are like feature flags
          break
        }
        // the rest of the features need to check the usage
        case "usage":
        case "tier":
        case "package": {
          const currentUsage = entitlement.usage ?? 0
          const limit = entitlement.limit
          const units = entitlement.units
          // remaining usage given the units the user bought
          const remainingUsage = units ? units - currentUsage : undefined
          const remainingToLimit = limit ? limit - currentUsage : undefined

          // check limits first
          if (remainingToLimit && remainingToLimit <= 0) {
            this.waitUntil(
              this.analytics.ingestFeaturesVerification({
                ...analyticsPayload,
                latency: performance.now() - start,
                deniedReason: "LIMIT_EXCEEDED",
                subscriptionPhaseId: entitlement.subscriptionItem?.subscriptionPhase?.id!,
                subscriptionId: entitlement.subscriptionItem?.subscriptionPhase?.subscription?.id!,
              })
            )

            return Ok({
              currentUsage: currentUsage,
              limit: limit ?? undefined,
              units: units ?? undefined,
              featureType: entitlement.featureType,
              access: false,
              deniedReason: "LIMIT_EXCEEDED",
              remaining: remainingToLimit,
            })
          }

          // check usage
          if (remainingUsage && remainingUsage <= 0) {
            this.waitUntil(
              this.analytics.ingestFeaturesVerification({
                ...analyticsPayload,
                latency: performance.now() - start,
                deniedReason: "USAGE_EXCEEDED",
                subscriptionPhaseId: entitlement.subscriptionItem?.subscriptionPhase?.id!,
                subscriptionId: entitlement.subscriptionItem?.subscriptionPhase?.subscription?.id!,
              })
            )

            return Ok({
              currentUsage: currentUsage,
              limit: limit ?? undefined,
              featureType: entitlement.featureType,
              units: units ?? undefined,
              access: false,
              deniedReason: "USAGE_EXCEEDED",
              remaining: remainingUsage,
            })
          }

          break
        }

        default:
          this.logger.error("Unhandled feature type", {
            featureType: entitlement.featureType,
          })
          break
      }

      this.waitUntil(
        this.analytics
          .ingestFeaturesVerification({
            ...analyticsPayload,
            latency: performance.now() - start,
            subscriptionPhaseId: entitlement.subscriptionItem?.subscriptionPhase?.id!,
            subscriptionId: entitlement.subscriptionItem?.subscriptionPhase?.subscription?.id!,
          })
          .catch((error) =>
            this.logger.error("Error reporting usage to analytics ve", {
              error: JSON.stringify(error),
              analyticsPayload,
            })
          )
      )

      return Ok({
        featureType: entitlement.featureType,
        access: true,
      })
    } catch (e) {
      const error = e as Error
      this.logger.error("Unhandled error while verifying feature", {
        error: JSON.stringify(error),
        customerId: opts.customerId,
        featureSlug: opts.featureSlug,
        projectId: opts.projectId,
      })

      return Err(
        new UnPriceCustomerError({
          code: "UNHANDLED_ERROR",
          customerId: opts.customerId,
        })
      )
    }
  }

  public async reportUsage(opts: {
    customerId: string
    featureSlug: string
    projectId: string
    date: number
    usage: number
  }): Promise<Result<{ success: boolean; message?: string }, UnPriceCustomerError | FetchError>> {
    try {
      const { customerId, featureSlug, projectId, usage, date } = opts

      // get the item details from the cache or the db
      const res = await this._getCustomerEntitlementByDate({
        customerId,
        projectId,
        featureSlug,
        date,
      })

      if (res.err) {
        return res
      }

      const entitlement = res.val

      // TODO: should I report the usage even if the limit was exceeded?
      // for now let the customer report more usage than the limit but add notifications
      const threshold = 80 // notify when the usage is 80% or more
      const currentUsage = entitlement.usage ?? 0
      const limit = entitlement.limit
      const units = entitlement.units
      let message = ""
      let notifyUsage = false

      // check usage
      if (units) {
        const unitsPercentage = (currentUsage / units) * 100

        if (currentUsage >= units) {
          message = `Your feature ${featureSlug} has reached or exceeded its usage of ${units}. Current usage: ${unitsPercentage.toFixed(
            2
          )}% of its units usage. This is over the units by ${currentUsage - units}`
          notifyUsage = true
        } else if (unitsPercentage >= threshold) {
          message = `Your feature ${featureSlug} is at ${unitsPercentage.toFixed(
            2
          )}% of its units usage`
          notifyUsage = true
        }
      }

      // check limit
      if (limit) {
        const usagePercentage = (currentUsage / limit) * 100

        if (currentUsage >= limit) {
          // Usage has reached or exceeded the limit
          message = `Your feature ${featureSlug} has reached or exceeded its usage limit of ${limit}. Current usage: ${usagePercentage.toFixed(
            2
          )}% of its usage limit. This is over the limit by ${currentUsage - limit}`
          notifyUsage = true
        } else if (usagePercentage >= threshold) {
          // Usage is at or above the threshold
          message = `Your feature ${featureSlug} is at ${usagePercentage.toFixed(
            2
          )}% of its usage limit`
          notifyUsage = true
        }
      }

      // flat features don't have usage
      if (entitlement.featureType === "flat") {
        return Ok({
          success: true,
        })
      }

      this.waitUntil(
        Promise.all([
          // notify usage
          // TODO: add notification to email, slack?
          notifyUsage && Promise.resolve(),
          // report the usage to analytics db
          this.analytics
            .ingestFeaturesUsage({
              planVersionFeatureId: entitlement.featurePlanVersionId,
              subscriptionItemId: entitlement.subscriptionItemId,
              projectId: entitlement.projectId,
              usage: usage,
              date: opts.date,
              createdAt: Date.now(),
              entitlementId: entitlement.id,
              featureSlug: featureSlug,
              customerId: customerId,
              subscriptionPhaseId: entitlement.subscriptionItem?.subscriptionPhase?.id!,
              subscriptionId: entitlement.subscriptionItem?.subscriptionPhase?.subscription?.id!,
            })
            .then(() => {
              // TODO: Only available in pro plus plan
              // TODO: usage is not always sum to the current usage, could be counter, etc
              // also if there are many request per second, we could debounce the update somehow
              // only update the cache if the feature is realtime
              if (entitlement.realtime && this.cache) {
                this.cache.featureByCustomerId.set(`${customerId}:${featureSlug}`, {
                  ...entitlement,
                  usage: (entitlement.usage ?? 0) + usage,
                  lastUsageUpdateAt: Date.now(),
                })
              } else if (entitlement.realtime) {
                // update the usage in db
                this.db
                  .update(customerEntitlements)
                  .set({
                    usage: (entitlement.usage ?? 0) + usage,
                  })
                  .where(eq(customerEntitlements.id, entitlement.id))
              }
            })
            .catch((error) => {
              this.logger.error("Error reporting usage to analytics ingestFeaturesUsage", {
                error: JSON.stringify(error),
                entitlement: entitlement,
                usage: usage,
              })
            }),
        ])
      )

      return Ok({
        success: true,
        message,
      })
    } catch (e) {
      const error = e as Error
      this.logger.error("Unhandled error while reporting usage", {
        error: JSON.stringify(error),
        customerId: opts.customerId,
        featureSlug: opts.featureSlug,
        projectId: opts.projectId,
      })

      throw e
    }
  }

  public async signUp(opts: {
    input: CustomerSignUp
    projectId: string
  }): Promise<
    Result<
      { success: boolean; url: string; error?: string; customerId: string },
      UnPriceCustomerError | FetchError
    >
  > {
    const { input, projectId } = opts
    const {
      planVersionId,
      config,
      successUrl,
      cancelUrl,
      email,
      name,
      timezone,
      defaultCurrency,
      externalId,
    } = input

    const planVersion = await this.db.query.versions.findFirst({
      with: {
        project: true,
        plan: true,
      },
      where: (version, { eq, and }) =>
        and(eq(version.id, planVersionId), eq(version.projectId, projectId)),
    })

    if (!planVersion) {
      return Err(
        new UnPriceCustomerError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Plan version not found",
        })
      )
    }

    if (planVersion.status !== "published") {
      return Err(
        new UnPriceCustomerError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Plan version is not published",
        })
      )
    }

    if (planVersion.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Plan version is not active",
        })
      )
    }

    const planProject = planVersion.project
    const paymentProvider = planVersion.paymentProvider
    const paymentRequired = planVersion.paymentMethodRequired

    const customerId = newId("customer")
    const customerSuccessUrl = successUrl.replace("{CUSTOMER_ID}", customerId)

    // For the main project we use the default key
    // get config payment provider
    const configPaymentProvider = await this.db.query.paymentProviderConfig.findFirst({
      where: (config, { and, eq }) =>
        and(
          eq(config.projectId, projectId),
          eq(config.paymentProvider, paymentProvider),
          eq(config.active, true)
        ),
    })

    if (!configPaymentProvider) {
      return Err(
        new UnPriceCustomerError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Payment provider config not found or not active",
        })
      )
    }

    const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)

    const decryptedKey = await aesGCM.decrypt({
      iv: configPaymentProvider.keyIv,
      ciphertext: configPaymentProvider.key,
    })

    // if payment is required, we need to go through payment provider flow first
    if (paymentRequired) {
      const paymentProviderService = new PaymentProviderService({
        logger: this.logger,
        paymentProvider: paymentProvider,
        token: decryptedKey,
      })

      // create a session with the data of the customer, the plan version and the success and cancel urls
      // pass the session id to stripe metadata and then once the customer adds a payment method, we call our api to create the subscription
      const sessionId = newId("customer_session")
      const customerSession = await this.db
        .insert(customerSessions)
        .values({
          id: sessionId,
          customer: {
            id: customerId,
            name: name,
            email: email,
            currency: defaultCurrency || planProject.defaultCurrency,
            timezone: timezone || planProject.timezone,
            projectId: projectId,
            externalId: externalId,
          },
          planVersion: {
            id: planVersion.id,
            projectId: projectId,
            config: config,
          },
        })
        .returning()
        .then((data) => data[0])

      if (!customerSession) {
        return Err(
          new UnPriceCustomerError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Error creating customer session",
          })
        )
      }

      const { err, val } = await paymentProviderService.signUp({
        successUrl: customerSuccessUrl,
        cancelUrl: cancelUrl,
        customerSessionId: customerSession.id,
        customer: {
          id: customerId,
          email: email,
          currency: defaultCurrency || planProject.defaultCurrency,
          projectId: projectId,
        },
      })

      if (err ?? !val) {
        return Err(
          new UnPriceCustomerError({
            code: "INTERNAL_SERVER_ERROR",
            message: err.message,
          })
        )
      }

      return Ok({
        success: true,
        url: val.url,
        customerId: val.customerId,
      })
    }

    // if payment is not required, we can create the customer directly with its subscription
    try {
      await this.db.transaction(async (trx) => {
        const newCustomer = await trx
          .insert(customers)
          .values({
            id: customerId,
            name: name ?? email,
            email: email,
            projectId: projectId,
            defaultCurrency: defaultCurrency ?? planProject.defaultCurrency,
            timezone: timezone ?? planProject.timezone,
            active: true,
          })
          .returning()
          .then((data) => data[0])

        if (!newCustomer?.id) {
          return Err(
            new UnPriceCustomerError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Error creating customer",
            })
          )
        }

        const subscriptionService = new SubscriptionService({
          db: trx,
          cache: this.cache,
          metrics: this.metrics,
          logger: this.logger,
          waitUntil: this.waitUntil,
          analytics: this.analytics,
        })

        const { err, val: newSubscription } = await subscriptionService.createSubscription({
          input: {
            customerId: newCustomer.id,
            projectId: projectId,
            timezone: timezone ?? planProject.timezone,
            phases: [
              {
                planVersionId: planVersion.id,
                startAt: Date.now(),
                active: true,
                config: config,
                collectionMethod: planVersion.collectionMethod,
                whenToBill: planVersion.whenToBill,
                startCycle: planVersion.startCycle ?? 1,
                gracePeriod: planVersion.gracePeriod ?? 0,
              },
            ],
          },
          projectId: projectId,
        })

        if (err) {
          this.logger.error("Error creating subscription", {
            error: JSON.stringify(err),
          })

          trx.rollback()
          throw err
        }

        if (!newSubscription?.id) {
          return Err(
            new UnPriceCustomerError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Error creating subscription",
            })
          )
        }

        return { newCustomer, newSubscription }
      })

      return Ok({
        success: true,
        url: customerSuccessUrl,
        customerId: customerId,
      })
    } catch (error) {
      const err = error as Error

      return Ok({
        success: false,
        url: cancelUrl,
        error: `Error while signing up: ${err.message}`,
        customerId: "",
      })
    }
  }

  public async signOut(opts: {
    customerId: string
    projectId: string
  }): Promise<Result<{ success: boolean; message?: string }, UnPriceCustomerError | FetchError>> {
    const { customerId, projectId } = opts

    // cancel all subscriptions
    const customerSubs = await this.db.query.subscriptions.findMany({
      where: (subscription, { eq, and }) =>
        and(eq(subscription.customerId, customerId), eq(subscription.projectId, projectId)),
    })

    // all this should be in a transaction
    await this.db.transaction(async (tx) => {
      const cancelSubs = await Promise.all(
        customerSubs.map(async (sub) => {
          const subscriptionService = new SubscriptionService({
            db: tx,
            cache: this.cache,
            metrics: this.metrics,
            logger: this.logger,
            waitUntil: this.waitUntil,
            analytics: this.analytics,
          })

          // init phase machine
          const initPhaseMachineResult = await subscriptionService.initPhaseMachines({
            subscriptionId: sub.id,
            projectId,
          })

          if (initPhaseMachineResult.err) {
            throw initPhaseMachineResult.err
          }

          return await subscriptionService.cancelSubscription({
            now: Date.now(),
            subscriptionMetadata: {
              reason: "customer_signout",
              note: "Customer signed out",
            },
            phaseMetadata: {
              cancel: {
                reason: "customer_signout",
                note: "Customer signed out",
              },
            },
          })
        })
      )
        .catch((err) => {
          return Err(
            new FetchError({
              message: err.message,
              retry: false,
            })
          )
        })
        .then(() => true)

      if (!cancelSubs) {
        return Err(
          new UnPriceCustomerError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Error canceling subscription",
          })
        )
      }

      // Deactivate the customer
      await tx
        .update(customers)
        .set({
          active: false,
        })
        .where(eq(customers.id, customerId))
        .catch((err) => {
          return Err(
            new FetchError({
              message: err.message,
              retry: false,
            })
          )
        })
    })

    return Ok({
      success: true,
    })
  }
}
