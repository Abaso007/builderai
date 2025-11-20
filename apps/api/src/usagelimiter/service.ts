import { env } from "cloudflare:workers"
import type { Analytics } from "@unprice/analytics"
import type { Stats } from "@unprice/analytics/utils"
import type { Database } from "@unprice/db"
import type {
  EntitlementState,
  GetCurrentUsage,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import { type BaseError, Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type { Cache } from "@unprice/services/cache"
import type { CustomerService } from "@unprice/services/customers"
import { UnPriceCustomerError } from "@unprice/services/customers"
import type { Metrics } from "@unprice/services/metrics"
import type { DurableObjectProject } from "~/project/do"
import type { DurableObjectUsagelimiter } from "./do"
import type { GetEntitlementsRequest, GetUsageRequest, UsageLimiter } from "./interface"

// you would understand entitlements service if you think about it as feature flag system
// it's totally separated from billing system and you can give entitlements to customers
// without affecting the billing.
export class UsageLimiterService implements UsageLimiter {
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

  // in memory cache with size and TTL limits
  private updateCache(key: string, result: VerificationResult) {
    if (env.VERCEL_ENV === "production" && !result.allowed) {
      // enforce max size - remove oldest entry if at limit
      if (this.hashCache.size >= 1000) {
        // remove first (oldest) entry
        const firstKey = this.hashCache.keys().next().value
        if (firstKey) {
          this.hashCache.delete(firstKey)
        }
      }

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

  public async verify(
    data: VerifyRequest
  ): Promise<Result<VerificationResult, FetchError | UnPriceCustomerError>> {
    const key = `verify:${data.projectId}:${data.customerId}:${data.featureSlug}:`
    const cached = this.hashCache.get(key)

    // if we hit the same isolate we can return the cached result
    // only for request that are denied.
    // we don't use the normal swr cache here because it doesn't make sense to call
    // the cache layer, the idea is to speed up the next request
    if (cached && env.VERCEL_ENV === "production") {
      const result = JSON.parse(cached) as VerificationResult

      return Ok({ ...result, cacheHit: true })
    }

    const durableObject = this.getStub(this.getDurableObjectCustomerId(data.customerId))

    // TODO: implement this if the request is async, we can validate entitlement from cache

    // this is the most expensive call in terms of latency
    // this will trigger a call to the DO and validate the entitlement given the current usage
    const result = await durableObject.verify(data)

    // in extreme cases we hit in memory cache for the same isolate, speeding up the next request
    this.updateCache(key, result)

    return Ok(result)
  }

  public async reportUsage(
    data: ReportUsageRequest
  ): Promise<Result<ReportUsageResult, FetchError | UnPriceCustomerError>> {
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
        allowed: result.allowed,
        message: result.message,
        limit: result.limit,
        usage: result.usage,
        consumedFrom: result.consumedFrom,
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

  public async prewarmEntitlements(params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<void, BaseError>> {
    const durableObject = this.getStub(this.getDurableObjectCustomerId(params.customerId))
    const prewarmResult = await durableObject.prewarm(params)
    return Ok(prewarmResult)
  }

  public async getEntitlements(
    data: GetEntitlementsRequest
  ): Promise<Result<EntitlementState[], BaseError>> {
    const durableObject = this.getStub(this.getDurableObjectCustomerId(data.customerId))
    const { val: entitlements, err } = await durableObject.getEntitlements(data)

    if (err) {
      throw err
    }

    return Ok(entitlements)
  }

  public async getCurrentUsage(
    data: GetUsageRequest
  ): Promise<Result<GetCurrentUsage, FetchError | BaseError>> {
    // validate subscription is active
    const { val: subscription, err: subscriptionErr } =
      await this.customerService.getActiveSubscription({
        customerId: data.customerId,
        projectId: data.projectId,
        now: data.now,
      })

    if (subscriptionErr) {
      throw subscriptionErr
    }

    const phase = subscription.activePhase

    if (!phase) {
      return Err(
        new UnPriceCustomerError({
          code: "NO_ACTIVE_PHASE_FOUND",
          message: "Subscription doesn't have an active phase",
        })
      )
    }

    const durableObject = this.getStub(this.getDurableObjectCustomerId(data.customerId))
    const { val: currentUsage, err: currentUsageErr } = await durableObject.getEntitlements(data)

    if (currentUsageErr) {
      throw currentUsageErr
    }

    // TODO: check this and see if we can simplify this
    return Ok({
      planVersion: {
        description: phase.planVersion.description,
        flatPrice: "0",
        currentTotalPrice: "0",
        billingConfig: phase.planVersion.billingConfig,
      },
      subscription: {
        planSlug: subscription.planSlug,
        status: subscription.status,
        currentCycleEndAt: subscription.currentCycleEndAt,
        timezone: subscription.timezone,
        currentCycleStartAt: subscription.currentCycleStartAt,
        prorationFactor: 0,
        prorated: false,
      },
      phase: {
        trialEndsAt: phase.trialEndsAt,
        endAt: phase.endAt,
        trialUnits: phase.trialUnits,
        isTrial: false,
      },
      entitlement: currentUsage.map((entitlement) => ({
        featureSlug: entitlement.featureSlug,
        featureType: entitlement.featureType,
        isCustom: false,
        limit: entitlement.limit,
        usage: Number(entitlement.currentCycleUsage),
        max: entitlement.limit,
        freeUnits: 0,
        units: entitlement.limit,
        included: 0,
        price: "0",
        featureVersion: {
          id: entitlement.id,
          featureSlug: entitlement.featureSlug,
          featureType: entitlement.featureType,
          feature: {
            id: entitlement.id,
            slug: entitlement.featureSlug,
            name: entitlement.featureSlug,
            description: entitlement.featureSlug,
            type: entitlement.featureType,
          },
        },
      })),
    } as unknown as GetCurrentUsage)
  }
}
