import {
  type Database,
  type SQL,
  type TransactionDatabase,
  and,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "@unprice/db"

import type { CacheError } from "@unkey/cache"
import type { Analytics } from "@unprice/analytics"
import {
  customerEntitlements,
  customerSessions,
  customers,
  features,
  planVersionFeatures,
  projects,
  subscriptionPhases,
  subscriptions,
  versions,
} from "@unprice/db/schema"
import { AesGCM, newId } from "@unprice/db/utils"
import {
  type Customer,
  type CustomerEntitlementExtended,
  type CustomerPaymentMethod,
  type CustomerSignUp,
  type PaymentProvider,
  type Plan,
  type PlanVersion,
  type Project,
  type SubscriptionCache,
  getCurrentBillingWindow,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { env } from "../../env"
import type { CustomerCache } from "../cache"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { PaymentProviderService } from "../payment-provider/service"
import { SubscriptionService } from "../subscriptions/service"
import { retry } from "../utils/retry"
import { type DenyReason, UnPriceCustomerError } from "./errors"

export class CustomerService {
  private readonly db: Database | TransactionDatabase
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  }: {
    db: Database | TransactionDatabase
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
    this.waitUntil = waitUntil
    this.cache = cache
    this.metrics = metrics
  }

  private async getActiveSubscriptionData({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<SubscriptionCache | null> {
    const subscription = await this.db.query.subscriptions
      .findFirst({
        with: {
          customer: {
            columns: {
              active: true,
            },
          },
          project: {
            columns: {
              enabled: true,
            },
          },
          phases: {
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
            },
            where: (phase, { and, or, isNull, gte, lte }) =>
              and(lte(phase.startAt, now), or(isNull(phase.endAt), gte(phase.endAt, now))),
            limit: 1,
          },
        },
        where: and(
          eq(subscriptions.customerId, customerId),
          eq(subscriptions.projectId, projectId)
        ),
      })
      .then((res) => {
        if (!res) {
          return null
        }

        return {
          ...res,
          activePhase: res.phases[0] ?? null,
        }
      })
      .catch((e) => {
        this.logger.error("error getting getActiveSubscriptionData from db", {
          error: e.message,
        })

        return null
      })

    // return explicitly null to avoid cache miss
    // this is useful to avoid cache revalidation on keys that don't exist
    if (!subscription) {
      return null
    }

    return subscription as SubscriptionCache
  }

  public getEntitlementCacheKey(entitlement: CustomerEntitlementExtended): string {
    return `${entitlement.projectId}:${entitlement.customerId}:${entitlement.featureSlug}`
  }

  private async getCustomerData(customerId: string): Promise<CustomerCache | null> {
    const customer = await this.db.query.customers.findFirst({
      with: {
        project: {
          with: {
            workspace: true,
          },
        },
      },
      where: (customer, { eq }) => eq(customer.id, customerId),
    })

    if (!customer) {
      return null
    }

    return customer
  }

  public async getCustomer(
    customerId: string,
    opts?: {
      skipCache: boolean
    }
  ): Promise<Result<CustomerCache | null, FetchError | UnPriceCustomerError>> {
    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getCustomer", {
        customerId,
      })
    }

    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getCustomerData(customerId),
          (err) =>
            new FetchError({
              message: `unable to query for getCustomerData, ${err.message}`,
              retry: false,
            })
        )
      : await retry(
          3,
          async () => this.cache.customer.swr(customerId, () => this.getCustomerData(customerId)),
          (attempt, err) => {
            this.logger.warn("Failed to fetch getCustomerData data from cache, retrying...", {
              customerId: customerId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting getCustomerData", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: `unable to query db for getCustomerData, ${err.message}`,
          retry: false,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    return Ok(val)
  }

  // validate the customer has and active subscription and is active
  public async getActiveSubscription({
    customerId,
    projectId,
    now,
    opts,
  }: {
    customerId: string
    projectId: string
    now: number
    opts?: {
      skipCache: boolean
    }
  }): Promise<Result<SubscriptionCache, FetchError | UnPriceCustomerError>> {
    const cacheKey = `${projectId}:${customerId}`

    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getActiveSubscription", {
        customerId,
        projectId,
      })
    }

    // swr handle cache stampede and other problems for us :)
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getActiveSubscriptionData({
            customerId,
            projectId,
            now,
          }),
          (err) =>
            new FetchError({
              message: `unable to query db for getActiveSubscriptionData, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                method: "getActiveSubscription",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerSubscription.swr(cacheKey, () =>
              this.getActiveSubscriptionData({
                customerId,
                projectId,
                now,
              })
            ),
          (attempt, err) => {
            this.logger.warn(
              "Failed to fetch getActiveSubscriptionData data from cache, retrying...",
              {
                customerId: customerId,
                attempt,
                error: err.message,
              }
            )
          }
        )

    if (err) {
      this.logger.error("error getting customer subscription", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: false,
          cause: err,
        })
      )
    }

    if (opts?.skipCache) {
      // set the cache to null to avoid cache miss if the subscription is not found
      this.waitUntil(this.cache.customerSubscription.set(cacheKey, val ?? null))
    }

    if (!val) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_FOUND",
          message: "subscription not found or is not active for this customer",
        })
      )
    }

    if (val.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_ACTIVE",
          message: "subscription is not active",
        })
      )
    }

    if (!val.activePhase) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_FOUND",
          message: "subscription doesn't have an active phase",
        })
      )
    }

    if (val.project.enabled === false) {
      return Err(
        new UnPriceCustomerError({
          code: "PROJECT_DISABLED",
          message: "project is disabled",
        })
      )
    }

    if (val.customer.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_DISABLED",
          message: "customer is disabled",
        })
      )
    }

    return Ok(val)
  }

  public async syncEntitlementsCache({
    entitlements,
  }: {
    entitlements: CustomerEntitlementExtended[]
  }): Promise<void> {
    // set cache
    const promises: Promise<Result<void, CacheError>>[] = []
    entitlements.forEach((entitlement) => {
      promises.push(
        this.cache.customerEntitlement.set(
          `${entitlement.projectId}:${entitlement.customerId}:${entitlement.featureSlug}`,
          entitlement
        )
      )
    })

    // Execute with concurrency limit to avoid overwhelming the system
    const BATCH_SIZE = 100
    for (let i = 0; i < promises.length; i += BATCH_SIZE) {
      const batch = promises.slice(i, i + BATCH_SIZE)
      await Promise.all(batch)

      // Small delay between batches
      if (i + BATCH_SIZE < promises.length) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    return
  }

  public async syncActiveEntitlementsLastUsage({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<CustomerEntitlementExtended[], FetchError | UnPriceCustomerError>> {
    // get latest data from db
    const { err: subscriptionErr, val: subscription } = await this.getActiveSubscription({
      customerId,
      projectId,
      now,
      opts: {
        skipCache: true,
      },
    })

    if (subscriptionErr) {
      return Err(subscriptionErr)
    }

    const currentPhase = subscription?.activePhase

    if (!currentPhase || !subscription) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_FOUND",
          message: "subscription not found or is not active for this customer",
        })
      )
    }

    const { customerEntitlements: entitlements } = currentPhase
    const entitlementIds = entitlements.map((entitlement) => {
      return {
        entitlementId: entitlement.id,
        aggregationMethod: entitlement.featurePlanVersion.aggregationMethod,
        featureType: entitlement.featurePlanVersion.featureType,
      }
    })

    // get the billing window on which now is
    const billingWindow = getCurrentBillingWindow({
      now,
      anchor: currentPhase.billingAnchor,
      interval: currentPhase.planVersion.billingConfig.billingInterval,
      intervalCount: currentPhase.planVersion.billingConfig.billingIntervalCount,
      trialEndsAt: currentPhase.trialEndsAt,
      endAt: currentPhase.endAt,
    })

    // get the usage from analytics
    const usages = await this.analytics.getUsageBillingEntitlements({
      customerId,
      projectId,
      entitlements: entitlementIds,
      startAt: billingWindow.start,
      endAt: billingWindow.end,
      includeAccumulatedUsage: true,
    })

    const sqlChunksEntitlementsUsage: SQL[] = []
    const sqlChunksEntitlementsAccumulatedUsage: SQL[] = []

    const ids: string[] = []
    sqlChunksEntitlementsUsage.push(sql`(case`)
    sqlChunksEntitlementsAccumulatedUsage.push(sql`(case`)

    // we set the usage only if the entitlements are in the same period
    for (const entitlement of entitlements) {
      const entitlementUsage = usages?.find((usage) => usage.entitlementId === entitlement.id)
      // if the usage is not found, use the entitlement usage
      const usage = entitlementUsage?.usage ?? Number(entitlement.currentCycleUsage)
      const accumulatedUsage =
        entitlementUsage?.accumulatedUsage ?? Number(entitlement.accumulatedUsage)

      if (
        !entitlementUsage &&
        ["usage", "package", "tier"].includes(entitlement.featurePlanVersion.aggregationMethod)
      ) {
        // don't throw an error, just continue
        this.logger.warn(`Usage not found for entitlement ${entitlement.id}`)
      }

      sqlChunksEntitlementsUsage.push(
        sql`when ${customerEntitlements.id} = ${entitlement.id} then cast(${usage.toString()} as int)`
      )

      sqlChunksEntitlementsAccumulatedUsage.push(
        sql`when ${customerEntitlements.id} = ${entitlement.id} then cast(${accumulatedUsage.toString()} as int)`
      )

      ids.push(entitlement.id)
    }

    sqlChunksEntitlementsUsage.push(sql`end)`)
    sqlChunksEntitlementsAccumulatedUsage.push(sql`end)`)
    const finalSqlEntitlementsUsage: SQL = sql.join(sqlChunksEntitlementsUsage, sql.raw(" "))
    const finalSqlEntitlementsAccumulatedUsage: SQL = sql.join(
      sqlChunksEntitlementsAccumulatedUsage,
      sql.raw(" ")
    )

    try {
      const entitlementsUpdated = await this.db
        .update(customerEntitlements)
        .set({
          currentCycleUsage: finalSqlEntitlementsUsage,
          accumulatedUsage: finalSqlEntitlementsAccumulatedUsage,
          lastUsageUpdateAt: Date.now(),
          updatedAtM: Date.now(),
          resetedAt: Date.now(),
        })
        .where(and(inArray(customerEntitlements.id, ids)))
        .returning()
        .then((res) => res)
        .catch((e) => {
          throw e
        })

      if (!entitlementsUpdated || entitlementsUpdated.length === 0) {
        this.logger.info("no entitlements updated", {
          customerId,
          projectId,
        })

        return Ok([])
      }

      const result = entitlements
        .map((entitlement) => {
          const entitlementUpdated = entitlementsUpdated.find((e) => e.id === entitlement.id)
          if (!entitlementUpdated) {
            return undefined
          }

          return {
            ...entitlement,
            currentCycleUsage: entitlementUpdated.currentCycleUsage,
            accumulatedUsage: entitlementUpdated.accumulatedUsage,
            lastUsageUpdateAt: entitlementUpdated.lastUsageUpdateAt,
            featureSlug: entitlement.featurePlanVersion.feature.slug,
            featureType: entitlement.featurePlanVersion.featureType,
            aggregationMethod: entitlement.featurePlanVersion.aggregationMethod,
            project: subscription.project,
            customer: subscription.customer,
            subscription: {
              active: subscription.active,
              currentCycleStartAt: subscription.currentCycleStartAt,
              currentCycleEndAt: subscription.currentCycleEndAt,
            },
            activePhase: {
              billingConfig: currentPhase.planVersion.billingConfig,
              endAt: currentPhase.endAt,
              trialDays: currentPhase.trialDays,
              trialEndsAt: currentPhase.trialEndsAt,
              billingAnchor: currentPhase.billingAnchor,
              startAt: currentPhase.startAt,
            },
          }
        })
        .filter((e) => e !== undefined)

      return Ok(result)
    } catch (e) {
      this.logger.error(
        `error syncing entitlements last usage - ${e instanceof Error ? e.message : "unknown error"}`,
        {
          customerId,
          projectId,
          error: JSON.stringify(e),
        }
      )

      return Err(
        new UnPriceCustomerError({
          code: "ERROR_SYNCING_ENTITLEMENTS_LAST_USAGE",
          message: "error syncing entitlements last usage",
        })
      )
    }
  }

  // get all active entitlements for this customer
  private async getEntitlementsData({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<CustomerEntitlementExtended[] | null> {
    const start = performance.now()

    // if not found in DO, then we query the db
    // if not found in DO, then we query the db
    const entitlements = await this.db.query.subscriptionPhases
      .findFirst({
        columns: {
          startAt: true,
          endAt: true,
          billingAnchor: true,
          trialDays: true,
          trialEndsAt: true,
        },
        with: {
          planVersion: {
            columns: {
              billingConfig: true,
            },
          },
          project: {
            columns: {
              enabled: true,
            },
          },
          subscription: {
            columns: {
              active: true,
              currentCycleStartAt: true,
              currentCycleEndAt: true,
            },
            with: {
              customer: {
                columns: {
                  active: true,
                },
              },
            },
          },
          customerEntitlements: {
            with: {
              featurePlanVersion: {
                columns: {
                  aggregationMethod: true,
                  featureType: true,
                },
                with: {
                  feature: true,
                },
              },
            },
          },
        },
        where: (phase, { and, or, isNull, gte, lte }) =>
          and(lte(phase.startAt, now), or(isNull(phase.endAt), gte(phase.endAt, now))),
      })
      .then((e) => {
        if (!e) {
          return null
        }

        const { customerEntitlements, subscription, project, planVersion, ...phase } = e

        return customerEntitlements.map((e) => {
          return {
            ...e,
            featureType: e.featurePlanVersion.featureType,
            aggregationMethod: e.featurePlanVersion.aggregationMethod,
            featureSlug: e.featurePlanVersion.feature.slug,
            activePhase: {
              ...phase,
              billingConfig: planVersion.billingConfig,
            },
            project: project,
            subscription: subscription,
            customer: subscription.customer,
          }
        })
      })
      .catch((e) => {
        this.logger.error(
          `error getting entitlements in getEntitlementsData from db - ${e.message}`,
          {
            error: JSON.stringify(e),
            customerId,
            projectId,
            now,
          }
        )

        throw e
      })

    const end = performance.now()

    this.metrics.emit({
      metric: "metric.db.read",
      query: "getActiveEntitlements",
      duration: end - start,
      service: "customer",
      customerId,
      projectId,
    })

    return entitlements
  }

  public async getActiveEntitlements({
    customerId,
    projectId,
    now,
    opts,
  }: {
    customerId: string
    projectId: string
    now: number
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<CustomerEntitlementExtended[], FetchError | UnPriceCustomerError>> {
    const cacheKey = `${projectId}:${customerId}`

    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getActiveEntitlements", {
        customerId,
        projectId,
      })
    }

    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getEntitlementsData({
            customerId,
            projectId,
            now,
          }),
          (err) =>
            new FetchError({
              message: `unable to query entitlement from db in getEntitlementsData - ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                method: "getEntitlementsData",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerEntitlements.swr(cacheKey, () =>
              this.getEntitlementsData({
                customerId,
                projectId,
                now,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch entitlements data from cache, retrying...", {
              customerId: customerId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting entitlements", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (opts?.skipCache) {
      // set the cache to null to avoid cache miss if the entitlements are not found
      this.waitUntil(this.cache.customerEntitlements.set(cacheKey, val ?? null))
    }

    if (!val || val.length === 0) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_ENTITLEMENTS_NOT_FOUND",
          message: "customer has no entitlements",
        })
      )
    }

    return Ok(val)
  }

  private async getEntitlementData({
    customerId,
    featureSlug,
    projectId,
    now,
  }: {
    customerId: string
    featureSlug: string
    projectId: string
    now: number
  }): Promise<CustomerEntitlementExtended | null> {
    const start = performance.now()

    const entitlement = await this.db
      .select({
        project: {
          enabled: projects.enabled,
        },
        customer: {
          active: customers.active,
        },
        subscription: {
          active: subscriptions.active,
          currentCycleStartAt: subscriptions.currentCycleStartAt,
          currentCycleEndAt: subscriptions.currentCycleEndAt,
        },
        activePhase: {
          startAt: subscriptionPhases.startAt,
          endAt: subscriptionPhases.endAt,
          billingAnchor: subscriptionPhases.billingAnchor,
          trialDays: subscriptionPhases.trialDays,
          trialEndsAt: subscriptionPhases.trialEndsAt,
          billingConfig: versions.billingConfig,
        },
        customerEntitlements,
        featureType: planVersionFeatures.featureType,
        aggregationMethod: planVersionFeatures.aggregationMethod,
        featureSlug: features.slug,
      })
      .from(customers)
      .leftJoin(projects, and(eq(customers.projectId, projects.id)))
      .leftJoin(
        subscriptions,
        and(
          eq(customers.id, subscriptions.customerId),
          eq(customers.projectId, subscriptions.projectId)
        )
      )
      .leftJoin(
        subscriptionPhases,
        and(
          eq(subscriptions.id, subscriptionPhases.subscriptionId),
          eq(subscriptions.projectId, subscriptionPhases.projectId),
          and(
            lte(subscriptionPhases.startAt, now),
            or(isNull(subscriptionPhases.endAt), gte(subscriptionPhases.endAt, now))
          )
        )
      )
      .leftJoin(
        versions,
        and(
          eq(subscriptionPhases.planVersionId, versions.id),
          eq(subscriptionPhases.projectId, versions.projectId)
        )
      )
      .leftJoin(
        customerEntitlements,
        and(
          eq(customers.id, customerEntitlements.customerId),
          eq(customers.projectId, customerEntitlements.projectId)
        )
      )
      .leftJoin(
        planVersionFeatures,
        and(
          eq(customerEntitlements.featurePlanVersionId, planVersionFeatures.id),
          eq(customerEntitlements.projectId, planVersionFeatures.projectId)
        )
      )
      .leftJoin(
        features,
        and(
          eq(planVersionFeatures.featureId, features.id),
          eq(planVersionFeatures.projectId, features.projectId)
        )
      )
      .where(
        and(
          eq(features.slug, featureSlug),
          eq(customers.id, customerId),
          eq(customers.projectId, projectId),
          eq(subscriptionPhases.id, customerEntitlements.subscriptionPhaseId)
        )
      )
      .then((e) => {
        const entitlement = e[0]

        if (
          !entitlement ||
          !entitlement?.customerEntitlements?.id ||
          !entitlement.featureType ||
          !entitlement.aggregationMethod ||
          !entitlement.featureSlug
        ) {
          return null
        }

        return {
          ...entitlement.customerEntitlements,
          featureType: entitlement.featureType,
          aggregationMethod: entitlement.aggregationMethod,
          featureSlug: entitlement.featureSlug,
          project: entitlement.project?.enabled === null ? null : entitlement.project,
          customer: entitlement.customer?.active === null ? null : entitlement.customer,
          subscription: entitlement.subscription?.active === null ? null : entitlement.subscription,
          activePhase:
            entitlement.activePhase?.billingConfig === null ? null : entitlement.activePhase,
        } as CustomerEntitlementExtended
      })
      .catch((e) => {
        this.logger.error(
          `error getting entitlement in getEntitlementData from db - ${e.message}`,
          {
            error: JSON.stringify(e),
            customerId,
            featureSlug,
            projectId,
            now,
          }
        )

        throw e
      })

    const end = performance.now()

    this.metrics.emit({
      metric: "metric.db.read",
      query: "getActiveEntitlement",
      duration: end - start,
      service: "customer",
      customerId,
      featureSlug,
      projectId,
    })

    if (!entitlement) {
      return null
    }

    if (
      !entitlement.activePhase ||
      !entitlement.project ||
      !entitlement.customer ||
      !entitlement.subscription
    ) {
      this.logger.warn("error getting entitlement all data in getEntitlementData", {
        customerId,
        projectId,
        entitlementId: entitlement.id,
        activePhase: entitlement.activePhase,
        project: entitlement.project,
        customer: entitlement.customer,
        subscription: entitlement.subscription,
      })

      return entitlement
    }

    let usage = entitlement.currentCycleUsage
    let accumulatedUsage = entitlement.accumulatedUsage

    // get the last usage from analytics only for usage, package and tier features
    const shouldRefreshUsage = !["flat"].includes(entitlement.featureType)

    if (shouldRefreshUsage) {
      // calculate the start time of the current billing window so we can get the usage until now
      const { start: startAt, end: endAt } = getCurrentBillingWindow({
        now,
        anchor: entitlement.activePhase.billingAnchor,
        interval: entitlement.activePhase.billingConfig.billingInterval,
        intervalCount: entitlement.activePhase.billingConfig.billingIntervalCount,
        trialEndsAt: entitlement.activePhase.trialEndsAt,
        endAt: entitlement.activePhase.endAt,
      })

      // if it was reset within current billing window, we don't include accumulated
      const includeAccumulatedUsage =
        entitlement.resetedAt < startAt || entitlement.resetedAt > endAt
      const lastUsageUpdateIsInCurrentBillingWindow =
        entitlement.lastUsageUpdateAt >= startAt && entitlement.lastUsageUpdateAt < endAt

      const result = await this.analytics.getUsageBillingEntitlements({
        customerId,
        projectId,
        entitlements: [
          {
            entitlementId: entitlement.id,
            aggregationMethod: entitlement.aggregationMethod,
            featureType: entitlement.featureType,
          },
        ],
        startAt: startAt,
        endAt: now, // get the usage until now
        includeAccumulatedUsage: includeAccumulatedUsage,
      })

      const entitlmenteResult = result?.find((r) => r.entitlementId === entitlement.id)
      // don't use the accumulated usage if it was reseted within the current billing window
      let lastUsage = entitlmenteResult?.usage
      let lastAccumulatedUsage = includeAccumulatedUsage
        ? entitlmenteResult?.accumulatedUsage
        : Number(entitlement.accumulatedUsage)

      let lastUsageUpdateAt = Date.now()
      let resetedAt = Date.now()

      if (!lastUsage) {
        this.logger.warn("error getting usage from analytics in getEntitlementData", {
          customerId,
          projectId,
          entitlementId: entitlement.id,
          startAt: new Date(startAt).toISOString(),
          endAt: new Date(now).toISOString(),
        })

        // as a safety net we use the accumulated usage of the entitlement
        lastUsage = Number(entitlement.currentCycleUsage)
        lastUsageUpdateAt = entitlement.lastUsageUpdateAt

        // but if the entitlement last usage update was outside of the current billing window then we reset
        if (!lastUsageUpdateIsInCurrentBillingWindow) {
          lastUsage = 0
          lastUsageUpdateAt = Date.now()
        }
      }

      if (!lastAccumulatedUsage) {
        this.logger.warn("error getting accumulated usage from analytics in getEntitlementData", {
          customerId,
          projectId,
          entitlementId: entitlement.id,
        })

        lastAccumulatedUsage = Number(entitlement.accumulatedUsage)
        resetedAt = entitlement.resetedAt
      }

      // update the usage
      usage = lastUsage.toString()
      accumulatedUsage = lastAccumulatedUsage.toString()

      // update the entitlement with the new usage
      this.waitUntil(
        this.db
          .update(customerEntitlements)
          .set({
            currentCycleUsage: usage,
            accumulatedUsage: accumulatedUsage,
            resetedAt: resetedAt,
            lastUsageUpdateAt: lastUsageUpdateAt,
            updatedAtM: Date.now(),
          })
          .where(eq(customerEntitlements.id, entitlement.id))
      )

      // update the entitlement with the new usage
      entitlement.currentCycleUsage = usage
      entitlement.accumulatedUsage = accumulatedUsage
      entitlement.resetedAt = resetedAt
      entitlement.lastUsageUpdateAt = lastUsageUpdateAt
      entitlement.updatedAtM = Date.now()
    }

    const result = {
      ...entitlement,
      usage: usage,
      accumulatedUsage: accumulatedUsage,
    }

    return result
  }

  public async getPaymentProvider({
    customerId,
    projectId,
    provider,
  }: {
    customerId?: string
    projectId: string
    provider: PaymentProvider
  }): Promise<Result<PaymentProviderService, FetchError | UnPriceCustomerError>> {
    let customerData: Customer | undefined

    // validate customer if provided
    if (customerId) {
      customerData = await this.db.query.customers.findFirst({
        where: (customer, { and, eq }) => and(eq(customer.id, customerId)),
      })

      if (!customerData) {
        return Err(
          new UnPriceCustomerError({
            code: "CUSTOMER_NOT_FOUND",
            message: "Customer not found",
          })
        )
      }
    }

    // get config payment provider
    const config = await this.db.query.paymentProviderConfig
      .findFirst({
        where: (config, { and, eq }) =>
          and(
            eq(config.projectId, projectId),
            eq(config.paymentProvider, provider),
            eq(config.active, true)
          ),
      })
      .catch((e) => {
        this.logger.error("error getting payment provider config", {
          error: e.message,
          customerId,
          projectId,
          provider,
        })

        throw e
      })

    if (!config) {
      return Err(
        new UnPriceCustomerError({
          code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
          message: "Payment provider config not found or not active",
        })
      )
    }

    const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)

    const decryptedKey = await aesGCM.decrypt({
      iv: config.keyIv,
      ciphertext: config.key,
    })

    const paymentProviderService = new PaymentProviderService({
      customer: customerData,
      logger: this.logger,
      paymentProvider: provider,
      token: decryptedKey,
    })

    return Ok(paymentProviderService)
  }

  public async _getActiveEntitlement(
    customerId: string,
    featureSlug: string,
    projectId: string,
    now: number,
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  ): Promise<Result<CustomerEntitlementExtended, FetchError | UnPriceCustomerError>> {
    const cacheKey = `${projectId}:${customerId}:${featureSlug}`

    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getActiveEntitlement", {
        customerId,
        projectId,
        featureSlug,
      })
    }

    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getEntitlementData({
            customerId,
            featureSlug,
            projectId,
            now,
          }),
          (err) =>
            new FetchError({
              message: `unable to query entitlement from db in getEntitlementData - ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                method: "getEntitlementData",
                skipCache: opts?.skipCache,
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerEntitlement.swr(cacheKey, () =>
              this.getEntitlementData({
                customerId,
                featureSlug,
                projectId,
                now,
              })
            ),
          (attempt, err) => {
            this.logger.warn(
              "Failed to fetch entitlement data from cache in getEntitlementData, retrying...",
              {
                customerId: customerId,
                featureSlug,
                projectId,
                attempt,
                error: err.message,
                skipCache: opts?.skipCache,
              }
            )
          }
        )

    if (err) {
      this.logger.error("error getting entitlement in getEntitlementData", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    // null will mean cache miss
    const result = val ?? null

    if (err) {
      return Err(err)
    }

    // if the entitlement is found, and the cache is skipped, update the cache
    // this is important to avoid stale data
    if (opts?.skipCache) {
      this.waitUntil(this.cache.customerEntitlement.set(cacheKey, result))
    }

    const { err: validateErr, val: validatedEntitlement } = this.validateEntitlement({
      entitlement: val,
      now,
    })

    if (validateErr) {
      return Err(validateErr)
    }

    return Ok(validatedEntitlement)
  }

  public validateEntitlement({
    entitlement,
    now,
  }: {
    entitlement: CustomerEntitlementExtended | null | undefined
    now: number
  }): Result<CustomerEntitlementExtended, UnPriceCustomerError> {
    if (!entitlement) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_FOUND",
          message: "Entitlement not found. Please verify the entitlement and the customer data.",
        })
      )
    }

    if (!entitlement.project) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_FOUND",
          message: "Project not found. Please verify the entitlement and the customer data.",
        })
      )
    }

    if (!entitlement.customer) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_FOUND",
          message: "Customer not found. Please verify the entitlement and the customer data.",
        })
      )
    }

    if (!entitlement.subscription) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_FOUND",
          message: "Subscription not found. Please verify the entitlement and the customer data.",
        })
      )
    }

    if (!entitlement.activePhase) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_FOUND",
          message: "Active phase not found. Please verify the entitlement and the customer data.",
        })
      )
    }

    // subscription is not active
    if (entitlement.subscription.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_ACTIVE",
          message: "this subscription is not active. Please contact support.",
        })
      )
    }

    // project is not enabled
    if (entitlement.project.enabled === false) {
      return Err(
        new UnPriceCustomerError({
          code: "PROJECT_DISABLED",
          message: "this project is disabled. Please contact support.",
        })
      )
    }

    // customer is not active
    if (entitlement.customer.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_DISABLED",
          message: "this customer is disabled. Please contact support.",
        })
      )
    }

    // entitlement is not active
    if (entitlement.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_ACTIVE",
          message: "this entitlement is not active. Please contact support.",
        })
      )
    }

    if (
      now < entitlement.activePhase.startAt ||
      now > (entitlement.activePhase.endAt ?? Number.POSITIVE_INFINITY)
    ) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_FOUND",
          message: "Phase is not active. Please contact support.",
        })
      )
    }

    // last validation would be if the entitlemnt is outside of the current billing window
    // we have to retry without cache to update the usage
    const currentCycleWindow = getCurrentBillingWindow({
      now: entitlement.lastUsageUpdateAt,
      anchor: entitlement.activePhase.billingAnchor,
      interval: entitlement.activePhase.billingConfig.billingInterval,
      intervalCount: entitlement.activePhase.billingConfig.billingIntervalCount,
      trialEndsAt: entitlement.activePhase.trialEndsAt,
      endAt: entitlement.activePhase.endAt,
    })

    const outsideOfCurrentBillingWindow =
      now < currentCycleWindow.start || now > currentCycleWindow.end

    if (outsideOfCurrentBillingWindow) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_OUTSIDE_OF_CURRENT_BILLING_WINDOW",
          message:
            "Entitlement is outside of the current billing window. Please verify the entitlement and the customer data.",
        })
      )
    }

    return Ok(entitlement)
  }

  // a feature slug is active only once at a time per customer and project
  // so we need to get the active entitlement for a feature slug
  // we have to be mindful as well that entitlement in cache could become stale so there must be a validation
  // if the entitlment last usage update was outside of the current billing window we revalidate
  // this way we can make sure we have the latest data
  public async getActiveEntitlement(
    customerId: string,
    featureSlug: string,
    projectId: string,
    now: number,
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  ): Promise<Result<CustomerEntitlementExtended, FetchError | UnPriceCustomerError>> {
    const { val, err } = await this._getActiveEntitlement(
      customerId,
      featureSlug,
      projectId,
      now,
      opts
    )

    if (err) {
      // if the entitlement check failed and it is from db
      // then this means there is nothing we can do about but to return error
      if (opts?.skipCache) {
        return Err(err)
      }

      // if the entitment check failed because of the current billing window
      // then we can try to refresh the entitlement
      if (err.code === "ENTITLEMENT_OUTSIDE_OF_CURRENT_BILLING_WINDOW") {
        const { err: refreshErr, val: refreshedEntitlement } = await this._getActiveEntitlement(
          customerId,
          featureSlug,
          projectId,
          now,
          {
            skipCache: true,
          }
        )

        if (refreshErr) {
          return Err(refreshErr)
        }

        return Ok(refreshedEntitlement)
      }

      return Err(err)
    }

    return Ok(val)
  }

  // this is the method that calculate the usage and will
  // reset the usage if it's outside of the current billing window
  public calculateEntitlementUsage({
    entitlement,
    usage,
  }: {
    entitlement: CustomerEntitlementExtended
    usage: number
  }):
    | {
        success: true
        message: string
        usage: number
        accumulatedUsage: number
        limit?: number
      }
    | {
        success: false
        message: string
        deniedReason: DenyReason
        accumulatedUsage: number
        limit?: number
        usage: number
      } {
    // check flat features
    if (entitlement.featureType === "flat") {
      return {
        success: false,
        message:
          "feature is flat, limit is not applicable, but events are billed. Please don't report usage for flat features to avoid overbilling.",
        deniedReason: "FLAT_FEATURE_NOT_ALLOWED_REPORT_USAGE",
        usage: 1,
        limit: 1,
        accumulatedUsage: 0,
      }
    }

    if (Number(usage) < 0 && !["sum", "sum_all"].includes(entitlement.aggregationMethod)) {
      return {
        success: false,
        message: `Usage cannot be negative when the feature type is not sum or sum_all, got ${entitlement.aggregationMethod}. This will disturb aggregations.`,
        deniedReason: "INCORRECT_USAGE_REPORTING",
        usage: Number(entitlement.currentCycleUsage),
        limit: entitlement.limit ?? undefined,
        accumulatedUsage: Number(entitlement.accumulatedUsage),
      }
    }

    // get the current usage
    const { usage: newUsage, accumulatedUsage: newAccumulatedUsage } =
      this.calculateUsagePerFeature({
        aggregationMethod: entitlement.aggregationMethod,
        usage: usage,
        accumulatedUsage: Number(entitlement.accumulatedUsage),
        currentCycleUsage: Number(entitlement.currentCycleUsage),
      })

    // check limit
    const limitCheck = this.checkLimitEntitlement({
      entitlement: {
        ...entitlement,
        currentCycleUsage: newUsage.toString(),
        accumulatedUsage: newAccumulatedUsage.toString(),
      },
      opts: {
        allowOverage: true,
      },
    })

    return {
      success: true,
      message: limitCheck.message,
      usage: newUsage,
      limit: limitCheck.limit,
      accumulatedUsage: newAccumulatedUsage,
    }
  }

  private calculateUsagePerFeature({
    aggregationMethod,
    usage,
    accumulatedUsage,
    currentCycleUsage,
  }: {
    aggregationMethod: string
    usage: number
    accumulatedUsage: number
    currentCycleUsage: number
  }): {
    usage: number
    accumulatedUsage: number
  } {
    switch (aggregationMethod) {
      case "sum": {
        const newUsage = currentCycleUsage + usage
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }
      case "max": {
        const newUsage = Math.max(currentCycleUsage, usage)
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }

      case "last_during_period": {
        const newUsage = usage
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }
      case "count": {
        const newUsage = currentCycleUsage + 1
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }
      case "count_all": {
        const newUsage = accumulatedUsage + 1
        const newAccumulatedUsage = accumulatedUsage + 1
        return {
          usage: newUsage,
          accumulatedUsage: newAccumulatedUsage,
        }
      }
      case "max_all": {
        const newUsage = Math.max(accumulatedUsage, usage)
        const newAccumulatedUsage = newUsage
        return {
          usage: newUsage,
          accumulatedUsage: newAccumulatedUsage,
        }
      }
      case "sum_all": {
        const newUsage = accumulatedUsage + usage
        const newAccumulatedUsage = newUsage
        return {
          usage: newUsage,
          accumulatedUsage: newAccumulatedUsage,
        }
      }
      default:
        return {
          usage: currentCycleUsage,
          accumulatedUsage: accumulatedUsage,
        }
    }
  }

  // will check the limit and reset the usage if needed
  public checkLimitEntitlement({
    entitlement,
    opts = {
      allowOverage: false,
    },
  }: {
    entitlement: CustomerEntitlementExtended
    opts?: {
      allowOverage?: boolean
    }
  }):
    | {
        valid: true
        message: string
        limit?: number
        usage?: number
        deniedReason?: DenyReason
        hitLimit?: boolean
        notifyUsage?: boolean
      }
    | {
        valid: false
        message: string
        deniedReason: DenyReason
        limit?: number
        usage?: number
        hitLimit?: boolean
        notifyUsage?: boolean
      } {
    switch (entitlement.featureType) {
      case "flat":
        return { valid: true, message: "flat feature is not applicable for usage limit" }
      case "tier":
      case "package":
      case "usage": {
        const threshold = 95 // notify when the usage is 95% or more
        const limit = entitlement.limit ? Number(entitlement.limit) : undefined
        const usage = Number(entitlement.currentCycleUsage)

        let message = ""
        let notifyUsage = false
        let hitLimit = false

        // if there is a limit defined we validate it
        if (limit) {
          // we trust in the usage of the cycle
          hitLimit = usage >= limit
          const usagePercentage = (usage / limit) * 100

          if (hitLimit) {
            // Usage has reached or exceeded the limit
            message = `Your feature ${entitlement.featureSlug} has reached or exceeded its usage limit of ${limit}. ${opts?.allowOverage ? "Overage is allowed" : ""}`
            notifyUsage = true

            if (opts?.allowOverage) {
              return {
                valid: true,
                message: message,
                limit: Number(limit),
                usage: Number(usage),
                hitLimit: hitLimit,
                notifyUsage: notifyUsage,
              }
            }

            // if limit is hit and overage is not allowed
            return {
              valid: false,
              message: message,
              deniedReason: "LIMIT_EXCEEDED",
              limit: Number(limit),
              usage: Number(usage),
              hitLimit: hitLimit,
              notifyUsage: notifyUsage,
            }
          }

          // if limmit not hit, but usage is at or above the threshold
          if (usagePercentage >= threshold) {
            // Usage is at or above the threshold
            message = `Your feature ${entitlement.featureSlug} is at ${usagePercentage.toFixed(
              2
            )}% of its usage limit`
            notifyUsage = true

            return {
              valid: true,
              message: message,
              limit: Number(limit),
              usage: Number(usage),
              notifyUsage: notifyUsage,
            }
          }
        }

        // no limit set then it's valid
        return {
          valid: true,
          message: message,
          limit: Number(limit),
          usage: Number(usage),
        }
      }
      default:
        return {
          valid: false,
          deniedReason: "ENTITLEMENT_NOT_FOUND",
          message: "invalid entitlement type",
        }
    }
  }

  private async getPaymentMethodsData({
    customerId,
    projectId,
    provider,
  }: {
    customerId: string
    projectId: string
    provider: PaymentProvider
  }): Promise<CustomerPaymentMethod[]> {
    const { val: paymentProviderService, err } = await this.getPaymentProvider({
      customerId,
      projectId,
      provider,
    })

    if (err) {
      return []
    }

    try {
      const customerId = paymentProviderService.getCustomerId()

      if (!customerId) {
        this.logger.error("payment provider customer ID not found", {
          customerId,
          projectId,
          provider,
        })
        return []
      }

      const { err, val } = await paymentProviderService.listPaymentMethods({
        limit: 5,
      })

      if (err) {
        this.logger.error("payment provider error", {
          customerId,
          projectId,
          provider,
          error: err.message,
        })
        return []
      }

      return val
    } catch (err) {
      const error = err as Error

      this.logger.error("payment provider error", {
        customerId,
        projectId,
        provider,
        error: error.message,
      })
      return []
    }
  }

  public async getPaymentMethods({
    customerId,
    provider,
    projectId,
    opts,
  }: {
    customerId: string
    provider: PaymentProvider
    projectId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<CustomerPaymentMethod[], FetchError | UnPriceCustomerError>> {
    // first try to get the payment methods from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getPaymentMethodsData({
            customerId,
            provider,
            projectId,
          }),
          (err) =>
            new FetchError({
              message: "unable to query payment methods from db",
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                provider: provider,
                method: "getPaymentMethods",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerPaymentMethods.swr(`${customerId}:${provider}`, () =>
              this.getPaymentMethodsData({
                customerId,
                provider,
                projectId,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch payment methods data from cache, retrying...", {
              customerId: customerId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting payment methods", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (!val) {
      return Ok([])
    }

    return Ok(val)
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
      planSlug,
      sessionId,
      billingInterval,
      metadata,
    } = input

    // plan version clould be empty, in which case we have to guess the best plan for the customer
    // given the currency, the plan slug and the version
    let planVersion: (PlanVersion & { project: Project; plan: Plan }) | null = null
    let pageId: string | null = null

    if (sessionId) {
      // if session id is provided, we need to get the plan version from the session
      // get the session from analytics
      const data = await this.analytics.getPlanClickBySessionId({
        session_id: sessionId,
        action: "plan_click",
      })

      const session = data.data.at(0)

      if (!session) {
        return Err(
          new UnPriceCustomerError({
            code: "PLAN_VERSION_NOT_FOUND",
            message: "Session not found",
          })
        )
      }

      pageId = session.payload.page_id

      planVersion = await this.db.query.versions
        .findFirst({
          with: {
            project: true,
            plan: true,
          },
          where: (version, { eq, and }) =>
            and(eq(version.id, session.payload.plan_version_id), eq(version.projectId, projectId)),
        })
        .then((data) => data ?? null)
    } else if (planVersionId) {
      planVersion = await this.db.query.versions
        .findFirst({
          with: {
            project: true,
            plan: true,
          },
          where: (version, { eq, and }) =>
            and(
              eq(version.id, planVersionId),
              eq(version.projectId, projectId),
              // filter by currency if provided
              defaultCurrency ? eq(version.currency, defaultCurrency) : undefined
            ),
        })
        .then((data) => data ?? null)
    } else if (planSlug) {
      // find the plan version by the plan slug
      const plan = await this.db.query.plans
        .findFirst({
          with: {
            versions: {
              with: {
                project: true,
                plan: true,
              },
              where: (version, { eq, and }) =>
                and(
                  // filter by latest version
                  eq(version.latest, true),
                  // filter by project
                  eq(version.projectId, projectId),
                  // filter by currency if provided
                  defaultCurrency ? eq(version.currency, defaultCurrency) : undefined
                ),
            },
          },
          where: (plan, { eq, and }) => and(eq(plan.projectId, projectId), eq(plan.slug, planSlug)),
        })
        .then((data) => {
          if (!data) {
            return null
          }

          // filter by billing interval if provided
          if (billingInterval) {
            const versions = data.versions.filter(
              (version) => version.billingConfig.billingInterval === billingInterval
            )

            return {
              ...data,
              versions: versions ?? [],
            }
          }

          return data
        })

      if (!plan) {
        return Err(
          new UnPriceCustomerError({
            code: "PLAN_VERSION_NOT_FOUND",
            message: "Plan version not found",
          })
        )
      }

      planVersion = plan.versions[0] ?? null
    }

    // if no plan version is provided, we use the default plan
    if (!planVersion) {
      // if no plan version is provided, we use the default plan
      const defaultPlan = await this.db.query.plans.findFirst({
        where: (plan, { eq, and }) =>
          and(eq(plan.projectId, projectId), eq(plan.defaultPlan, true)),
      })

      if (!defaultPlan) {
        return Err(
          new UnPriceCustomerError({
            code: "NO_DEFAULT_PLAN_FOUND",
            message: "Default plan not found, provide a plan version id, slug or session id",
          })
        )
      }

      planVersion = await this.db.query.versions
        .findFirst({
          with: {
            project: true,
            plan: true,
          },
          where: (version, { eq, and }) =>
            and(
              eq(version.planId, defaultPlan.id),
              eq(version.latest, true),
              eq(version.status, "published"),
              eq(version.active, true)
            ),
        })
        .then((data) => data ?? null)
    }

    if (!planVersion) {
      return Err(
        new UnPriceCustomerError({
          code: "PLAN_VERSION_NOT_FOUND",
          message: "Plan version not found",
        })
      )
    }

    if (planVersion.status !== "published") {
      return Err(
        new UnPriceCustomerError({
          code: "PLAN_VERSION_NOT_PUBLISHED",
          message: "Plan version is not published",
        })
      )
    }

    if (planVersion.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "PLAN_VERSION_NOT_ACTIVE",
          message: "Plan version is not active",
        })
      )
    }

    const planProject = planVersion.project
    const paymentProvider = planVersion.paymentProvider
    const paymentRequired = planVersion.paymentMethodRequired
    const currency = defaultCurrency ?? planProject.defaultCurrency
    const defaultBillingInterval = billingInterval ?? planVersion.billingConfig.billingInterval

    if (
      defaultBillingInterval &&
      planVersion.billingConfig.billingInterval !== defaultBillingInterval
    ) {
      return Err(
        new UnPriceCustomerError({
          code: "BILLING_INTERVAL_MISMATCH",
          message: "Billing interval mismatch",
        })
      )
    }

    // validate the currency if provided
    if (currency !== planVersion.currency) {
      return Err(
        new UnPriceCustomerError({
          code: "CURRENCY_MISMATCH",
          message:
            "Currency mismatch, the project default currency does not match the plan version currency",
        })
      )
    }

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
          code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
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
      const customerSessionId = newId("customer_session")
      const customerSession = await this.db
        .insert(customerSessions)
        .values({
          id: customerSessionId,
          customer: {
            id: customerId,
            name: name,
            email: email,
            currency: currency,
            timezone: timezone || planProject.timezone,
            projectId: projectId,
            externalId: externalId,
            metadata: metadata,
          },
          planVersion: {
            id: planVersion.id,
            projectId: projectId,
            config: config,
            paymentMethodRequired: paymentRequired,
          },
          metadata: {
            sessionId: sessionId ?? undefined,
            pageId: pageId ?? undefined,
          },
        })
        .returning()
        .then((data) => data[0])

      if (!customerSession) {
        return Err(
          new UnPriceCustomerError({
            code: "CUSTOMER_SESSION_NOT_CREATED",
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
          currency: currency,
          projectId: projectId,
        },
      })

      if (err) {
        return Err(
          new UnPriceCustomerError({
            code: "PAYMENT_PROVIDER_ERROR",
            message: err.message,
          })
        )
      }

      if (!val) {
        return Err(
          new UnPriceCustomerError({
            code: "PAYMENT_PROVIDER_ERROR",
            message: "Error creating payment provider signup",
          })
        )
      }

      // send event to analytics for tracking conversions
      this.waitUntil(
        this.analytics.ingestEvents({
          action: "signup",
          version: "1",
          session_id: sessionId ?? "",
          project_id: projectId,
          timestamp: new Date().toISOString(),
          payload: {
            customer_id: customerId,
            plan_version_id: planVersion.id,
            page_id: pageId,
            status: "waiting_payment_provider_setup",
          },
        })
      )

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
            defaultCurrency: currency,
            timezone: timezone ?? planProject.timezone,
            active: true,
            metadata: metadata,
          })
          .returning()
          .then((data) => data[0])

        if (!newCustomer?.id) {
          return Err(
            new UnPriceCustomerError({
              code: "CUSTOMER_NOT_CREATED",
              message: "Error creating customer",
            })
          )
        }

        const subscriptionService = new SubscriptionService({
          logger: this.logger,
          analytics: this.analytics,
          waitUntil: this.waitUntil,
          cache: this.cache,
          metrics: this.metrics,
          // pass the transaction to the subscription service
          // so we can rollback the transaction if something goes wrong
          db: trx,
        })

        const { err, val: newSubscription } = await subscriptionService.createSubscription({
          input: {
            customerId: newCustomer.id,
            projectId: projectId,
            timezone: timezone ?? planProject.timezone,
          },
          projectId: projectId,
        })

        if (err) {
          this.logger.error("Error creating subscription", {
            error: err.message,
          })

          trx.rollback()
          throw err
        }

        // create the phase
        const { err: createPhaseErr } = await subscriptionService.createPhase({
          input: {
            planVersionId: planVersion.id,
            startAt: Date.now(),
            config: config,
            paymentMethodRequired: planVersion.paymentMethodRequired,
            customerId: newCustomer.id,
            subscriptionId: newSubscription.id,
            currentCycleStartAt: Date.now(),
            currentCycleEndAt: Date.now(),
          },
          projectId: projectId,
          db: trx,
          now: Date.now(),
        })

        if (createPhaseErr) {
          trx.rollback()

          return Err(
            new UnPriceCustomerError({
              code: "PHASE_NOT_CREATED",
              message: "Error creating phase",
            })
          )
        }

        return { newCustomer, newSubscription }
      })

      // send event to analytics for tracking conversions
      this.waitUntil(
        this.analytics.ingestEvents({
          action: "signup",
          version: "1",
          session_id: sessionId ?? "",
          project_id: projectId,
          timestamp: new Date().toISOString(),
          payload: {
            customer_id: customerId,
            plan_version_id: planVersion.id,
            page_id: pageId,
            status: "signup_success",
          },
        })
      )

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

  // TODO: to implement
  // signout means cancel all subscriptions and deactivate the customer
  // cancel all entitlements
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
        customerSubs.map(async () => {
          // TODO: cancel the subscription
          return true
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
            code: "SUBSCRIPTION_NOT_CANCELED",
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
