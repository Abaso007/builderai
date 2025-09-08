import { env } from "cloudflare:workers"
import type { CacheError } from "@unkey/cache"
import type { Analytics } from "@unprice/analytics"
import type { Stats } from "@unprice/analytics/utils"
import type { Database } from "@unprice/db"
import {
  type CustomerEntitlementExtended,
  type GetCurrentUsage,
  type SubscriptionCache,
  calculateFlatPricePlan,
  calculateFreeUnits,
  calculatePricePerFeature,
  calculateTotalPricePlan,
  configureBillingCycleSubscription,
} from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type { Cache } from "@unprice/services/cache"
import type { CustomerService } from "@unprice/services/customers"
import { UnPriceCustomerError } from "@unprice/services/customers"
import type { Metrics } from "@unprice/services/metrics"
import type { DurableObjectProject } from "~/project/do"
import type { DurableObjectUsagelimiter } from "./do"
import type {
  CanRequest,
  CanResponse,
  GetEntitlementsRequest,
  GetEntitlementsResponse,
  GetUsageRequest,
  ReportUsageRequest,
  ReportUsageResponse,
} from "./interface"

// you would understand entitlements service if you think about it as feature flag system
// it's totally separated from billing system and you can give entitlements to customers
// without affecting the billing.
export class EntitlementService {
  private readonly namespace: DurableObjectNamespace<DurableObjectUsagelimiter>
  private readonly projectNamespace: DurableObjectNamespace<DurableObjectProject>
  private readonly logger: Logger
  private readonly metrics: Metrics
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly db: Database
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly customerService: CustomerService
  private readonly stats: Stats
  private readonly requestId: string
  private hashCache: Map<string, string>

  constructor(opts: {
    namespace: DurableObjectNamespace<DurableObjectUsagelimiter>
    projectNamespace: DurableObjectNamespace<DurableObjectProject>
    requestId: string
    domain?: string
    logger: Logger
    metrics: Metrics
    analytics: Analytics
    hashCache: Map<string, string>
    cache: Cache
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    db: Database
    customer: CustomerService
    stats: Stats
  }) {
    this.namespace = opts.namespace
    this.logger = opts.logger
    this.metrics = opts.metrics
    this.analytics = opts.analytics
    this.cache = opts.cache
    this.db = opts.db
    this.waitUntil = opts.waitUntil
    this.customerService = opts.customer
    this.projectNamespace = opts.projectNamespace
    this.stats = opts.stats
    this.requestId = opts.requestId
    this.hashCache = opts.hashCache
  }

  // in memory cache
  private async updateCache(key: string, result: CanResponse) {
    if (env.VERCEL_ENV === "production" && !result.success) {
      this.hashCache.set(key, JSON.stringify(result))
    }
  }

  // for EU countries we have to keep the stub in the EU namespace
  private getStub(
    name: string,
    locationHint?: DurableObjectLocationHint
  ): DurableObjectStub<DurableObjectUsagelimiter> {
    // jurisdiction is only available in production
    if (this.stats.isEUCountry && env.NODE_ENV === "production") {
      const euSubnamespace = this.namespace.jurisdiction("eu")
      const euStub = euSubnamespace.get(euSubnamespace.idFromName(name), {
        locationHint,
      })

      return euStub
    }

    return this.namespace.get(this.namespace.idFromName(name), {
      locationHint,
    })
  }

  private getDurableObjectCustomerId(customerId: string): string {
    // later on we can shard this by customer and feature slug if needed
    return `${customerId}`
  }

  /*
   * This is used to validate the subscription of the customer
   * It's used to check if the customer has an active subscription
   * @param customerId - The id of the customer
   * @param projectId - The id of the project
   * @returns The subscription of the customer
   */
  private async validateSubscription(
    customerId: string,
    projectId: string,
    now: number,
    opts?: {
      skipCache?: boolean
    }
  ): Promise<Result<SubscriptionCache, FetchError | UnPriceCustomerError>> {
    const { err: subscriptionErr, val: subscription } =
      await this.customerService.getActiveSubscription({
        customerId,
        projectId,
        now,
        opts: {
          skipCache: opts?.skipCache ?? false,
        },
      })

    if (subscriptionErr) {
      return Err(subscriptionErr)
    }

    return Ok(subscription)
  }

  public async revalidateEntitlement(data: {
    customerId: string
    featureSlug: string
    projectId: string
    timestamp: number
  }): Promise<
    Result<
      {
        success: boolean
        message: string
        entitlement?: CustomerEntitlementExtended
      },
      FetchError | UnPriceCustomerError
    >
  > {
    // deduplicate calls if the same request is made and we hit the same isolate
    const key = `revalidateEntitlement:${data.customerId}:${data.featureSlug}:${data.projectId}`
    const cached = this.hashCache.get(key)

    if (cached) {
      return Ok(JSON.parse(cached))
    }

    const durableObject = this.getStub(this.getDurableObjectCustomerId(data.customerId))

    // this is the most expensive call in terms of latency
    // this will trigger a call to the DO and validate the entitlement given the current usage
    const { err, val } = await durableObject.revalidateEntitlement({
      customerId: data.customerId,
      featureSlug: data.featureSlug,
      projectId: data.projectId,
      now: data.timestamp,
      opts: {
        skipCache: true,
      },
    })

    const result = {
      success: true,
      message: "entitlement revalidated",
      entitlement: val,
    }

    // if the entitlement is not found, return an error
    if (err || !val) {
      result.success = false
      result.message = err?.message ?? "entitlement not found"
      result.entitlement = val
    }

    this.hashCache.set(key, JSON.stringify(result))

    return Ok(result)
  }

  public async resetEntitlements(
    customerId: string,
    projectId: string
  ): Promise<
    Result<
      {
        success: boolean
        message: string
        slugs?: string[]
      },
      FetchError | UnPriceCustomerError
    >
  > {
    // deduplicate calls if the same request is made and we hit the same isolate
    const key = `resetEntitlements:${customerId}:${projectId}`
    const cached = this.hashCache.get(key)

    if (cached) {
      return Ok(JSON.parse(cached))
    }

    const durableObject = this.getStub(this.getDurableObjectCustomerId(customerId))
    const result = await durableObject.resetDO()

    if (!result.success) {
      return Err(
        new UnPriceCustomerError({
          code: "ERROR_RESETTING_DO",
          message: result.message,
        })
      )
    }

    // cache keys to remove
    const keys = result.slugs?.map((slug) => `${projectId}:${customerId}:${slug}`)

    // delete the cache
    this.waitUntil(
      Promise.all([
        this.cache.customerEntitlement.remove(keys ?? []),
        this.cache.customerEntitlements.remove(`${projectId}:${customerId}`),
        this.cache.customerSubscription.remove(`${projectId}:${customerId}`),
        // pre warm DO and cache again after the reset
        durableObject.prewarmDO({
          customerId,
          projectId,
          now: Date.now(),
          opts: {
            force: true, // force the prewarm to avoid ttl issues
          },
        }),
      ])
    )

    const resultCached = {
      success: true,
      message: "entitlements reseted",
      slugs: result.slugs ?? [],
    }

    // cache the result
    this.hashCache.set(key, JSON.stringify(resultCached))

    return Ok(resultCached)
  }

  public async can(
    data: CanRequest
  ): Promise<Result<CanResponse, FetchError | UnPriceCustomerError>> {
    const key = `can:${data.projectId}:${data.customerId}:${data.featureSlug}:`
    const cached = this.hashCache.get(key)

    // if we hit the same isolate we can return the cached result
    // only for request that are denied.
    // we don't use the normal swr cache here because it doesn't make sense to call
    // the cache layer, the idea is to speed up the next request
    if (cached && env.VERCEL_ENV === "production") {
      const result = JSON.parse(cached) as CanResponse

      return Ok({ ...result, cacheHit: true })
    }

    const durableObject = this.getStub(this.getDurableObjectCustomerId(data.customerId))

    // if the request is async, we can validate entitlement from cache
    if (data.fromCache) {
      const { err, val: entitlement } = await this.customerService.getActiveEntitlement(
        data.customerId,
        data.featureSlug,
        data.projectId,
        data.timestamp
      )

      if (err) {
        return Err(err)
      }

      const entitlementGuard = this.customerService.checkLimitEntitlement({
        entitlement: entitlement,
        opts: {
          allowOverage: false,
        },
      })

      const latency = performance.now() - data.performanceStart

      const result = {
        success: entitlementGuard.valid,
        message: entitlementGuard.message,
        deniedReason: entitlementGuard.deniedReason,
        limit: entitlementGuard.limit,
        usage: entitlementGuard.usage,
        latency: latency,
      }

      // report the verification event to the DO
      this.waitUntil(
        Promise.all([
          durableObject.insertVerification({
            entitlement: entitlement,
            success: entitlementGuard.valid,
            deniedReason: entitlementGuard.deniedReason,
            // add fromCache to the metadata to keep track of the request
            data: {
              ...data,
              metadata: {
                ...data.metadata,
                fromCache: true,
              },
            },
            latency: latency,
            alarm: {
              ensure: true,
              flushTime: data.flushTime,
            },
          }),
        ])
      )

      // save in memory cache
      this.updateCache(key, result)

      // return the result
      return Ok(result)
    }

    // this is the most expensive call in terms of latency
    // this will trigger a call to the DO and validate the entitlement given the current usage
    const result = await durableObject.can(data)

    // in extreme cases we hit in memory cache for the same isolate, speeding up the next request
    if (!result.success) {
      this.hashCache.set(key, JSON.stringify(result))
    }

    return Ok(result)
  }

  public async reportUsage(
    data: ReportUsageRequest
  ): Promise<Result<ReportUsageResponse, FetchError | UnPriceCustomerError>> {
    // in dev we use the idempotence key and timestamp to deduplicate reuse the same key for the same request
    const idempotentKey =
      env.VERCEL_ENV === "production"
        ? `${data.idempotenceKey}`
        : `${data.idempotenceKey}:${data.timestamp}`

    const cacheKey = `${data.projectId}:${data.customerId}:${data.featureSlug}:${idempotentKey}`
    // Fast path: check if the event has already been sent to the DO
    const { val: sent } = await this.cache.idempotentRequestUsageByHash.get(cacheKey)

    // if the usage is already sent, return the result
    if (sent) {
      return Ok({ ...sent, cacheHit: true })
    }

    const durableObject = this.getStub(this.getDurableObjectCustomerId(data.customerId))
    const result = await durableObject.reportUsage(data).then((result) => {
      return {
        success: result.success,
        message: result.message,
        limit: Number(result.limit),
        usage: Number(result.usage),
        notifyUsage: result.notifyUsage,
        deniedReason: result.deniedReason,
      }
    })

    this.waitUntil(
      // cache the result for the next time
      // update the cache with the new usage so we can check limit in the next request
      // without calling the DO again
      this.cache.idempotentRequestUsageByHash.set(cacheKey, result)
    )

    return Ok(result)
  }

  public async getEntitlements(
    req: GetEntitlementsRequest
  ): Promise<Result<GetEntitlementsResponse, FetchError | UnPriceCustomerError>> {
    const { customerId, projectId, now } = req

    const { err: subscriptionErr } = await this.validateSubscription(customerId, projectId, now)

    if (subscriptionErr) {
      return Err(subscriptionErr)
    }

    const { err: entitlementsErr, val: entitlements } =
      await this.customerService.getActiveEntitlements({
        customerId,
        projectId,
        now,
      })

    if (entitlementsErr) {
      return Err(entitlementsErr)
    }

    if (!entitlements || entitlements.length === 0) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_ENTITLEMENTS_NOT_FOUND",
          message: "customer has no entitlements",
        })
      )
    }

    return Ok({
      entitlements,
    })
  }

  public async getCurrentUsage(
    req: GetUsageRequest
  ): Promise<Result<GetCurrentUsage, FetchError | UnPriceCustomerError | CacheError>> {
    const { customerId, projectId, now } = req
    const cacheKey = `${projectId}:${customerId}`

    const { err: subscriptionErr, val: subscription } = await this.validateSubscription(
      customerId,
      projectId,
      now
    )

    if (subscriptionErr) {
      return Err(subscriptionErr)
    }

    const phase = subscription.activePhase

    if (!phase) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_FOUND",
          message: "subscription doesn't have an active phase",
        })
      )
    }

    const { err: entitlementsErr, val: entitlements } =
      await this.customerService.getActiveEntitlements({
        customerId,
        projectId,
        now,
      })

    if (entitlementsErr) {
      return Err(entitlementsErr)
    }

    const { err: resultErr, val: result } = await this.cache.getCurrentUsage.swr(
      cacheKey,
      async () => {
        const quantities = entitlements.reduce(
          (acc, entitlement) => {
            acc[entitlement.featurePlanVersionId] =
              entitlement.featureType === "usage"
                ? Number(entitlement.currentCycleUsage)
                : Number(entitlement.units)
            return acc
          },
          {} as Record<string, number>
        )

        const calculatedBillingCycle = configureBillingCycleSubscription({
          currentCycleStartAt: subscription.currentCycleStartAt,
          billingConfig: phase.planVersion.billingConfig,
          trialUnits: phase.trialDays,
          alignStartToDay: true,
          alignEndToDay: true,
          endAt: phase.endAt ?? undefined,
          alignToCalendar: true,
        })

        const { val: totalPricePlan, err: totalPricePlanErr } = calculateTotalPricePlan({
          features: phase.customerEntitlements.map((e) => e.featurePlanVersion),
          quantities: quantities,
          prorate: calculatedBillingCycle.prorationFactor,
          currency: phase.planVersion.currency,
        })

        const { err: flatPriceErr, val: flatPrice } = calculateFlatPricePlan({
          planVersion: {
            ...phase.planVersion,
            planFeatures: phase.customerEntitlements.map((e) => e.featurePlanVersion),
          },
          prorate: calculatedBillingCycle.prorationFactor,
        })

        if (totalPricePlanErr || flatPriceErr) {
          throw totalPricePlanErr || flatPriceErr
        }

        const result = {
          planVersion: {
            description: phase.planVersion.description,
            flatPrice: flatPrice.displayAmount,
            currentTotalPrice: totalPricePlan.displayAmount,
            billingConfig: phase.planVersion.billingConfig,
          },
          subscription: {
            planSlug: subscription.planSlug,
            status: subscription.status,
            currentCycleEndAt: subscription.currentCycleEndAt,
            timezone: subscription.timezone,
            currentCycleStartAt: subscription.currentCycleStartAt,
            prorationFactor: calculatedBillingCycle.prorationFactor,
            prorated: calculatedBillingCycle.prorationFactor !== 1,
          },
          phase: {
            trialEndsAt: phase.trialEndsAt,
            endAt: phase.endAt,
            trialDays: phase.trialDays,
            isTrial: phase.trialEndsAt ? Date.now() < phase.trialEndsAt : false,
          },
          entitlement: entitlements.map((e) => {
            const entitlementPhase = phase.customerEntitlements.find((p) => e.id === p.id)

            // if the entitlement is not found in the phase, it means it's a custom entitlement
            // no need to add price information
            if (!entitlementPhase) {
              const featureVersion = phase.customerEntitlements.find(
                (p) => p.featurePlanVersionId === e.featurePlanVersionId
              )
              return {
                featureSlug: e.featureSlug,
                featureType: e.featureType,
                isCustom: true,
                limit: e.limit,
                usage: Number(e.currentCycleUsage),
                units: e.units,
                freeUnits: 0,
                max: e.limit || Number.POSITIVE_INFINITY,
                included: 0,
                featureVersion: featureVersion?.featurePlanVersion!,
                price: null,
              }
            }

            const { config, featureType } = entitlementPhase.featurePlanVersion
            const freeUnits = calculateFreeUnits({ config: config!, featureType: featureType })
            const { val: price } = calculatePricePerFeature({
              config: config!,
              featureType: featureType,
              quantity: quantities[entitlementPhase.featurePlanVersionId] ?? 0,
              prorate: calculatedBillingCycle.prorationFactor,
            })

            return {
              featureSlug: e.featureSlug,
              featureType: e.featureType,
              limit: e.limit,
              usage: Number(e.currentCycleUsage),
              units: e.units,
              isCustom: false,
              freeUnits,
              included:
                freeUnits === Number.POSITIVE_INFINITY
                  ? e.limit || Number.POSITIVE_INFINITY
                  : freeUnits,
              price: price?.totalPrice.displayAmount ?? "0",
              max: e.limit || Number.POSITIVE_INFINITY,
              featureVersion: entitlementPhase.featurePlanVersion,
            }
          }),
        }

        return result
      }
    )

    if (resultErr) {
      return Err(resultErr)
    }

    if (!result) {
      return Err(
        new UnPriceCustomerError({
          code: "ENTITLEMENT_NOT_FOUND",
          message: "failed to get current usage",
        })
      )
    }

    this.waitUntil(this.cache.getCurrentUsage.set(cacheKey, result))

    return Ok(result)
  }
}
