import { type Connection, Server } from "partyserver"

import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import migrations from "../../drizzle/migrations"

import { Analytics } from "@unprice/analytics"
import { and, count, sql } from "drizzle-orm"
import { usageRecords, verifications } from "~/db/schema"
import type { schema } from "~/db/types"
import type { Env } from "~/env"
import type { CanRequest, ReportUsageRequest, ReportUsageResponse } from "./interface"

import { env } from "cloudflare:workers"
import { CloudflareStore } from "@unkey/cache/stores"
import { createConnection } from "@unprice/db"
import type { CustomerEntitlementExtended } from "@unprice/db/validators"
import { FetchError } from "@unprice/error"
import { Err, Ok, type Result } from "@unprice/error"
import { AxiomLogger, ConsoleLogger, type Logger } from "@unprice/logging"
import { CacheService } from "@unprice/services/cache"
import { CustomerService, type DenyReason, UnPriceCustomerError } from "@unprice/services/customers"
import { LogdrainMetrics, type Metrics, NoopMetrics } from "@unprice/services/metrics"

interface UsageLimiterConfig {
  entitlements: CustomerEntitlementExtended[]
  colo: string
  lastSyncUsageAt: number
}

// This durable object takes care of handling the usage of every feature per customer.
// It is used to validate the usage of a feature and to report the usage to tinybird.
// think of it as a queue that will be flushed to the db periodically
export class DurableObjectUsagelimiter extends Server {
  // if the do is initialized
  private initialized = false
  // once the durable object is initialized we can avoid
  // querying the db for usage on each request
  private featuresUsage: Map<string, CustomerEntitlementExtended> = new Map()
  // internal database of the do
  private db: DrizzleSqliteDODatabase<typeof schema>
  // tinybird analytics
  private analytics: Analytics
  // logger
  private logger: Logger
  // cache
  private cache: CacheService
  // metrics
  private metrics: Metrics
  // customer service
  private customerService: CustomerService
  // Default ttl for the usage records and verifications
  private readonly TTL_ANALYTICS = 1000 * 30 // 30 secs
  // Default ttl for updating usage from analytics to the db
  // we can optionally set and alarm to flush the usage to the db periodically
  private TTL_SYNC_USAGE = 1000 * 60 * 60 * 1 // 1 hour
  // Debounce delay for the broadcast
  private lastBroadcastTime = 0
  // debounce delay for the broadcast events
  private readonly DEBOUNCE_DELAY = 1000 * 1 // 1 second
  // Maps featureSlug to its current timeout ID for cache flushing
  private cacheWriteTimers: Map<
    string,
    {
      timerId: number | null // The ID of the current setTimeout for debouncing
      lastFlushTime: number // The last time the cache was flushed
    }
  > = new Map()
  // Configuration for cache flushing
  private readonly DEBOUNCE_DELAY_MS = 2000 // Time to wait for inactivity before flushing
  private readonly MAX_FLUSH_INTERVAL_MS = 5000 // Max time between flushes, even if active (5 seconds)

  // hibernate the do when no websocket nor connections are active
  static options = {
    hibernate: true,
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this.db = drizzle(ctx.storage, { logger: false })

    // set a revalidation period of 5 secs for development
    if (env.VERCEL_ENV === "development") {
      this.TTL_SYNC_USAGE = 1000 * 60 // 1 minute
    }

    // set a revalidation period of 5 mins for preview
    if (env.VERCEL_ENV === "preview") {
      this.TTL_SYNC_USAGE = 1000 * 60 * 30 // 5 mins
    }

    this.analytics = new Analytics({
      emit: env.EMIT_ANALYTICS.toString() === "true",
      tinybirdToken: env.TINYBIRD_TOKEN,
      tinybirdUrl: env.TINYBIRD_URL,
    })

    const emitMetrics = env.EMIT_METRICS_LOGS.toString() === "true"

    this.logger = emitMetrics
      ? new AxiomLogger({
          apiKey: env.AXIOM_API_TOKEN,
          dataset: env.AXIOM_DATASET,
          requestId: this.ctx.id.toString(),
          logLevel: env.VERCEL_ENV === "production" ? "error" : "debug",
          environment: env.NODE_ENV,
          service: "usagelimiter",
          defaultFields: {
            durableObjectId: this.ctx.id.toString(),
          },
        })
      : new ConsoleLogger({
          requestId: this.ctx.id.toString(),
          service: "usagelimiter",
          environment: env.NODE_ENV,
          logLevel: env.VERCEL_ENV === "production" ? "error" : "info",
          defaultFields: {
            durableObjectId: this.ctx.id.toString(),
          },
        })

    this.metrics = emitMetrics
      ? new LogdrainMetrics({
          requestId: this.ctx.id.toString(),
          environment: env.NODE_ENV,
          logger: this.logger,
          service: "usagelimiter",
        })
      : new NoopMetrics()

    this.cache = new CacheService(
      {
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        waitUntil: (promise: Promise<any>) => this.ctx.waitUntil(promise),
      },
      this.metrics,
      emitMetrics
    )

    const cloudflareCacheStore =
      env.CLOUDFLARE_ZONE_ID &&
      env.CLOUDFLARE_API_TOKEN &&
      env.CLOUDFLARE_ZONE_ID !== "" &&
      env.CLOUDFLARE_API_TOKEN !== ""
        ? new CloudflareStore({
            cloudflareApiKey: env.CLOUDFLARE_API_TOKEN,
            zoneId: env.CLOUDFLARE_ZONE_ID,
            domain: "cache.unprice.dev",
            cacheBuster: "v2",
          })
        : undefined

    const stores = []

    // push the cloudflare store first to hit it first
    if (cloudflareCacheStore) {
      stores.push(cloudflareCacheStore)
    }

    // register the cloudflare store if it is configured
    this.cache.init(stores)

    const cache = this.cache.getCache()

    this.customerService = new CustomerService({
      logger: this.logger,
      analytics: this.analytics,
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      waitUntil: (promise: Promise<any>) => this.ctx.waitUntil(promise),
      cache: cache,
      metrics: this.metrics,
      db: createConnection({
        env: env.NODE_ENV,
        primaryDatabaseUrl: env.DATABASE_URL,
        read1DatabaseUrl: env.DATABASE_READ1_URL,
        read2DatabaseUrl: env.DATABASE_READ2_URL,
        logger: env.DRIZZLE_LOG.toString() === "true",
        singleton: false, // Don't use singleton for hibernating DOs
      }),
    })

    // initialize the do
    this.initialize()

    // set the colo of the do
    this.setColo()
  }

  async setColo() {
    const config = await this.getConfig()

    // if not initialized, set the colo
    // localtion shouldn't change after the object is created
    if (config.colo === "" || config.colo === undefined) {
      let colo = "UNK"

      try {
        colo =
          (
            (await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text()).match(
              /^colo=(.+)/m
            ) as string[]
          )[1] ?? "UNK"
      } catch (e) {
        this.logger.error("error setting colo", {
          error: e instanceof Error ? e.message : "unknown error",
        })
      }

      config.colo = colo

      await this.updateConfig(config)
    }

    // block concurrency while setting the colo
    await this.ctx.blockConcurrencyWhile(async () => {
      this.metrics.setColo(config.colo)
    })
  }

  async initialize() {
    // if already initialized, return
    if (this.initialized) {
      return
    }

    // block concurrency while initializing
    await this.ctx.blockConcurrencyWhile(async () => {
      // all happen in a try catch to avoid crashing the do
      try {
        // migrate first
        await this._migrate()

        // save the config in the do storage
        const config = await this.getConfig()

        // initialize the state
        const entitlements = config.entitlements

        // user can't have the same feature slug at the same time
        entitlements.forEach((e) => {
          this.featuresUsage.set(e.featureSlug, e)
        })

        this.initialized = true
      } catch (e) {
        // all the initialization happens in a try catch to avoid crashing the do
        this.logger.error("error initializing do", {
          error: e instanceof Error ? e.message : "unknown error",
        })

        this.featuresUsage.clear()
        // clear the cache write timers
        for (const [, t] of this.cacheWriteTimers) if (t?.timerId) clearTimeout(t.timerId)
        this.cacheWriteTimers.clear()
        this.initialized = false
        this.ctx.storage.delete("config")
      }
    })
  }

  private async getConfig(): Promise<UsageLimiterConfig> {
    const raw = (await this.ctx.storage.get("config")) as UsageLimiterConfig | undefined
    return {
      entitlements: raw?.entitlements?.filter((e) => e?.id !== undefined) ?? [],
      colo: raw?.colo ?? "",
      lastSyncUsageAt: raw?.lastSyncUsageAt ?? 0,
    }
  }

  private async updateConfig(config: UsageLimiterConfig) {
    const cleanedEntitlements = config.entitlements?.filter((e) => e?.id !== undefined)
    await this.ctx.storage.put("config", {
      ...config,
      // clean the config from undefined entitlements
      entitlements: cleanedEntitlements.length > 0 ? cleanedEntitlements : [],
    })
  }

  private async deleteEntitlement(featureSlug: string) {
    const config = await this.getConfig()

    let entitlementsMap = new Map<string, CustomerEntitlementExtended>()
    let entitlements = config.entitlements

    // remove the entitlement from the config and remove duplicates by featureSlug
    // if duplicate found we keep the one with the lastUpdateUsageAt the highest
    entitlements = entitlements
      .filter((e) => e.featureSlug !== featureSlug)
      .sort((a, b) => b.lastUsageUpdateAt - a.lastUsageUpdateAt)

    // clean the entitlements from duplicates by featureSlug
    entitlementsMap = new Map(entitlements.map((e) => [e.featureSlug, e]))
    // push the entitlement to the array
    entitlements = Array.from(entitlementsMap.values())

    // update the config
    await this.updateConfig({
      entitlements: entitlements,
      colo: config.colo,
      lastSyncUsageAt: config.lastSyncUsageAt,
    })

    // update the state safely
    await this.ctx.blockConcurrencyWhile(async () => {
      // flush the cache if it is in the state
      await this.flushToCache(featureSlug)
      this.featuresUsage.delete(featureSlug)
      // clear the cache write timer
      const t = this.cacheWriteTimers.get(featureSlug)
      if (t?.timerId) clearTimeout(t.timerId)
      this.cacheWriteTimers.delete(featureSlug)
    })
  }

  private async updateEntitlement(entitlement: CustomerEntitlementExtended) {
    const config = await this.getConfig()

    let entitlementsMap = new Map<string, CustomerEntitlementExtended>()
    let entitlements = config.entitlements

    // remove the entitlement from the config and remove duplicates by featureSlug
    // if duplicate found we keep the one with the lastUpdateUsageAt the highest
    entitlements = entitlements
      .filter((e) => e.id !== entitlement.id)
      .sort((a, b) => b.lastUsageUpdateAt - a.lastUsageUpdateAt)

    // push the entitlement to the array
    entitlements.push(entitlement)
    // sort the entitlements by lastUsageUpdateAt
    entitlements.sort((a, b) => b.lastUsageUpdateAt - a.lastUsageUpdateAt)
    // clean the entitlements from duplicates by featureSlug
    entitlementsMap = new Map(entitlements.map((e) => [e.featureSlug, e]))
    // push the entitlement to the array
    entitlements = Array.from(entitlementsMap.values())

    // update the config
    await this.updateConfig({
      entitlements: entitlements,
      colo: config.colo,
      lastSyncUsageAt: config.lastSyncUsageAt,
    })

    // update the state
    await this.ctx.blockConcurrencyWhile(async () => {
      this.featuresUsage.set(entitlement.featureSlug, entitlement)
    })
  }

  public async getEntitlements(): Promise<CustomerEntitlementExtended[]> {
    const config = await this.getConfig()
    return config.entitlements
  }

  // this is a simple way to revalidate the entitlement
  private async getEntitlement({
    customerId,
    projectId,
    featureSlug,
    now,
    opts,
  }: {
    customerId: string
    projectId: string
    featureSlug: string
    now: number
    opts?: {
      forceRefresh?: boolean
    }
  }): Promise<Result<CustomerEntitlementExtended, FetchError | UnPriceCustomerError>> {
    // get entitlement from memory, it should be here if the DO is initialized
    let entitlement = this.featuresUsage.get(featureSlug)
    let isValid = true

    // if entitlement is not in memory, get it from cache
    if (!entitlement || !entitlement.activePhase) {
      const { err, val } = await this.revalidateEntitlement({
        customerId,
        projectId,
        featureSlug,
        now,
        opts: {
          skipCache: false,
        },
      })

      if (err) {
        return Err(err)
      }

      entitlement = val
    }

    // we have a push model where the entitlement is revalidaded on every important event
    // although we also have a lazy revalidation to keep this in sync with the db
    const { err: validateEntitlementErr } = this.customerService.validateEntitlement({
      entitlement,
      now,
    })

    if (validateEntitlementErr) {
      isValid = false
    }

    if (Boolean(opts?.forceRefresh) || !isValid) {
      if (!isValid) {
        this.logger.info(
          `entitlement is not valid, forcing revalidation ${validateEntitlementErr?.message}`,
          {
            customerId,
            projectId,
            featureSlug,
            now,
            reason: validateEntitlementErr?.code,
          }
        )
      }

      // if for some reason is not valid again, revalidate will delete it from state
      // so we don't run into an infinite loop of revalidations
      const { err, val } = await this.revalidateEntitlement({
        customerId,
        projectId,
        featureSlug,
        now,
        opts: {
          skipCache: true, // skip cache to force revalidation
        },
      })

      if (err) {
        return Err(err)
      }

      entitlement = val
    }

    return Ok(entitlement)
  }

  public async revalidateEntitlement({
    customerId,
    projectId,
    featureSlug,
    now,
    opts,
  }: {
    customerId: string
    projectId: string
    featureSlug: string
    now: number
    opts?: {
      skipCache?: boolean
    }
  }): Promise<Result<CustomerEntitlementExtended, FetchError | UnPriceCustomerError>> {
    // if we need the last usage, we need to send the usage to tinybird first
    if (opts?.skipCache) {
      this.logger.debug("force refreshing to entitlement from DO", {
        customerId,
        projectId,
        featureSlug,
        now,
      })

      // INFO: if we can tolarate some staleness we can trigger this in background
      // we have to await these to make sure the usage is sent to tinybird first
      // we make sure to send the usage and verifications to tinybird for the featureSlug
      await this.sendUsageToTinybird({
        featureSlug,
      })

      await this.sendVerificationsToTinybird({
        featureSlug,
      })
    }

    // get the entitlement from the db
    const { err, val } = await this.customerService.getActiveEntitlement(
      customerId,
      featureSlug,
      projectId,
      now,
      {
        skipCache: Boolean(opts?.skipCache),
      }
    )

    if (err) {
      // if error we have to delete the entitlement from the do state
      // this is to avoid an infinite loop of revalidations
      await this.deleteEntitlement(featureSlug)
      return Err(err)
    }

    // update the config entitlement in the do state
    await this.updateEntitlement(val)

    return Ok(val)
  }

  /**
   * Schedules a debounced cache update for a feature slug,
   * ensuring it flushes within a maximum interval even under continuous activity.
   * @param featureSlug The identifier for the feature whose usage is being updated.
   */
  private scheduleCacheUpdateWithMaxInterval(featureSlug: string) {
    let updateState = this.cacheWriteTimers.get(featureSlug)

    // Initialize state if it's the first time for this feature
    if (!updateState) {
      updateState = { timerId: null, lastFlushTime: Date.now() }
      this.cacheWriteTimers.set(featureSlug, updateState)
    }

    // Clear any existing debounce timer
    if (updateState.timerId) {
      clearTimeout(updateState.timerId)
    }

    // Determine the next target flush time
    const now = Date.now()
    const timeSinceLastFlush = now - updateState.lastFlushTime

    if (timeSinceLastFlush >= this.MAX_FLUSH_INTERVAL_MS) {
      // If it's been longer than the max interval since the last flush,
      // flush immediately instead of scheduling with delay=0
      this.ctx.waitUntil(this.flushToCache(featureSlug))
      return
    }

    // Otherwise, use the debounce delay.
    // But also ensure we don't exceed the MAX_FLUSH_INTERVAL_MS.
    // The actual delay will be the debounce delay, unless that would make
    // the total time since last flush exceed MAX_FLUSH_INTERVAL_MS.
    const timeUntilMaxFlush = this.MAX_FLUSH_INTERVAL_MS - timeSinceLastFlush
    const delayBeforeNextFlush = Math.min(this.DEBOUNCE_DELAY_MS, timeUntilMaxFlush)

    // Schedule the new timer
    const timerId = setTimeout(async () => {
      // Clear the timerId as this timer is about to execute
      if (updateState) {
        // Check if updateState still exists (should)
        updateState.timerId = null
      }
      this.ctx.waitUntil(this.flushToCache(featureSlug))
    }, delayBeforeNextFlush)

    updateState.timerId = Number(timerId)
  }

  private async flushToCache(featureSlug: string) {
    const entitlement = this.featuresUsage.get(featureSlug)

    if (!entitlement) {
      return
    }

    const cacheKey = this.customerService.getEntitlementCacheKey(entitlement)
    const cache = this.cache.getCache()

    this.logger.debug(
      `DO ID: ${this.ctx.id.toString()} - Flushing feature '${featureSlug}' usage ${entitlement.currentCycleUsage} to cache key: ${cacheKey}`
    )

    await cache.customerEntitlement.set(cacheKey, entitlement)
  }

  async _migrate() {
    try {
      await migrate(this.db, migrations)
    } catch (error) {
      // Log the error
      this.logger.error("error migrating DO", {
        error: error instanceof Error ? error.message : "unknown error",
      })

      throw error
    }
  }

  // when connected through websocket we can broadcast events to the client
  // realtime events are used to debug events in unprice dashboard
  async broadcastEvents(data: {
    customerId: string
    featureSlug: string
    deniedReason?: DenyReason
    usage?: number
    limit?: number
    notifyUsage?: boolean
    type: "can" | "reportUsage"
    success: boolean
  }) {
    const now = Date.now()

    // Only broadcast if enough time has passed since last broadcast
    // defailt 1 per second
    // this is used to debug events in real time in unprice dashboard
    if (now - this.lastBroadcastTime >= this.DEBOUNCE_DELAY) {
      // under the hood this validates if there are connections
      // and sends the event to all of them
      this.broadcast(JSON.stringify(data))
      this.lastBroadcastTime = now
    }
  }

  public async insertVerification({
    entitlement,
    data,
    latency,
    deniedReason,
    success,
    alarm,
  }: {
    entitlement: CustomerEntitlementExtended
    data: CanRequest
    latency: number
    deniedReason?: DenyReason
    success: boolean
    alarm?: {
      ensure?: boolean
      flushTime?: number
    }
  }) {
    if (alarm?.ensure) {
      await this.ensureAlarmIsSet(alarm.flushTime)
    }

    return this.db
      .insert(verifications)
      .values({
        entitlementId: entitlement.id,
        customerId: data.customerId,
        projectId: data.projectId,
        featureSlug: data.featureSlug,
        requestId: data.requestId,
        timestamp: data.timestamp,
        createdAt: Date.now(),
        success: success ? 1 : 0,
        latency: latency.toString() ?? "0",
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
        deniedReason: deniedReason,
        featurePlanVersionId: entitlement.featurePlanVersionId,
        subscriptionItemId: entitlement.subscriptionItemId,
        subscriptionPhaseId: entitlement.subscriptionPhaseId,
        subscriptionId: entitlement.subscriptionId,
      })
      .returning()
      .catch((e) => {
        this.logger.error("error inserting verification", {
          error: e instanceof Error ? e.message : "unknown error",
        })
        return null
      })
      .then((result) => {
        return result?.[0] ?? null
      })
  }

  public async can(data: CanRequest): Promise<{
    success: boolean
    message: string
    deniedReason?: DenyReason
    limit?: number
    usage?: number
    latency?: number
  }> {
    try {
      // make sure the do is initialized
      await this.initialize()

      // check if all the DO is initialized
      if (!this.initialized) {
        return {
          success: false,
          message: "DO not initialized",
          deniedReason: "DO_NOT_INITIALIZED",
        }
      }

      // get the entitlement
      const { err, val: entitlement } = await this.getEntitlement({
        customerId: data.customerId,
        projectId: data.projectId,
        featureSlug: data.featureSlug,
        now: data.timestamp,
      })

      if (err) {
        if (err instanceof UnPriceCustomerError) {
          return {
            success: false,
            message: err.message,
            deniedReason: err.code as DenyReason,
          }
        }

        if (err instanceof FetchError) {
          return {
            success: false,
            message: err.message,
            deniedReason: "FETCH_ERROR",
          }
        }

        return {
          success: false,
          message: "error getting entitlement from do.",
          deniedReason: "ENTITLEMENT_ERROR",
        }
      }

      // validate the entitlement
      const entitlementGuardResult = this.customerService.checkLimitEntitlement({
        entitlement,
        opts: {
          allowOverage: false,
        },
      })

      const latency = performance.now() - data.performanceStart

      // insert verification this is zero latency cuz insert to DO sqlite
      const verification = await this.insertVerification({
        entitlement,
        success: entitlementGuardResult.valid,
        deniedReason: entitlementGuardResult.deniedReason,
        data,
        latency,
        alarm: {
          ensure: true,
          flushTime: data.flushTime,
        },
      })

      if (!verification?.id) {
        this.logger.error("error inserting verification from do, please try again later", {
          projectId: data.projectId,
          customerId: data.customerId,
          featureSlug: data.featureSlug,
          deniedReason: "ERROR_INSERTING_VERIFICATION_DO",
        })

        return {
          success: false,
          message: "error inserting verification from do, please try again later",
          deniedReason: "ERROR_INSERTING_VERIFICATION_DO",
        }
      }

      return {
        success: entitlementGuardResult.valid,
        message: entitlementGuardResult.message,
        deniedReason: entitlementGuardResult.deniedReason,
        limit: Number(entitlementGuardResult.limit),
        usage: Number(entitlementGuardResult.usage),
        latency,
      }
    } catch (error) {
      this.logger.error("error can from do", {
        error: error instanceof Error ? error.message : "unknown error",
      })

      return {
        success: false,
        message: error instanceof Error ? error.message : "unknown error",
        deniedReason: "ERROR_INSERTING_VERIFICATION_DO",
      }
    } finally {
      this.flush()
      // clear the cache write timers
      for (const [, t] of this.cacheWriteTimers) if (t?.timerId) clearTimeout(t.timerId)
      this.cacheWriteTimers.clear()
    }
  }

  public async reportUsage(data: ReportUsageRequest): Promise<ReportUsageResponse> {
    try {
      // first initialize the do
      await this.initialize()

      // check if all the DO is initialized
      if (!this.initialized) {
        return {
          success: false,
          message: "DO not initialized",
          deniedReason: "DO_NOT_INITIALIZED",
        }
      }

      // get the entitlement
      const { err, val: entitlement } = await this.getEntitlement({
        customerId: data.customerId,
        projectId: data.projectId,
        featureSlug: data.featureSlug,
        now: data.timestamp,
      })

      if (err) {
        if (err instanceof UnPriceCustomerError) {
          return {
            success: false,
            message: err.message,
            deniedReason: err.code as DenyReason,
          }
        }

        if (err instanceof FetchError) {
          return {
            success: false,
            message: err.message,
            deniedReason: "FETCH_ERROR",
          }
        }

        return {
          success: false,
          message: "error getting entitlement from do.",
          deniedReason: "ENTITLEMENT_ERROR",
        }
      }

      // validate the usage
      // after validating, we set the usage and agregate it to the DO state for the next request.
      // keep in mind that database calls are 0 latency because of the Durable Object
      // we keep the agregated state in a map to avoid having to query the db for each request
      const usageGuard = this.customerService.calculateEntitlementUsage({
        entitlement,
        usage: Number(data.usage),
      })

      // if there is something wrong with the usage, we return an error
      // without reporting the usage to tinybird or the DO state
      if (usageGuard.success === false) {
        return {
          success: false,
          message: usageGuard.message,
          deniedReason: usageGuard.deniedReason,
          limit: usageGuard.limit,
          usage: usageGuard.usage,
        }
      }

      // ensure the alarm is set so we can send usage to tinybird periodically
      await this.ensureAlarmIsSet(data.flushTime)

      // insert usage into db
      const usageRecord = await this.db
        .insert(usageRecords)
        .values({
          customerId: data.customerId,
          featureSlug: data.featureSlug,
          // make sure to set the usage to 0 for flat features
          usage: entitlement.featureType === "flat" ? "0" : data.usage.toString(),
          timestamp: data.timestamp,
          idempotenceKey: data.idempotenceKey,
          requestId: data.requestId,
          projectId: data.projectId,
          featurePlanVersionId: entitlement.featurePlanVersionId,
          entitlementId: entitlement.id,
          subscriptionItemId: entitlement.subscriptionItemId,
          subscriptionPhaseId: entitlement.subscriptionPhaseId,
          subscriptionId: entitlement.subscriptionId,
          createdAt: Date.now(),
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
        })
        .returning()
        .catch((e) => {
          this.logger.error("error inserting usage from do", {
            error: e.message,
          })

          throw e
        })
        .then((result) => {
          return result?.[0] ?? null
        })

      if (!usageRecord?.id) {
        this.logger.error("error inserting usage from do, please try again later", {
          projectId: data.projectId,
          customerId: data.customerId,
          featureSlug: data.featureSlug,
          requestId: data.requestId,
          timestamp: data.timestamp,
          deniedReason: "ERROR_INSERTING_USAGE_DO",
        })

        return {
          success: false,
          message: "error inserting usage from do, please try again later",
          deniedReason: "ERROR_INSERTING_USAGE_DO",
        }
      }

      // update state
      await this.updateEntitlement({
        ...entitlement,
        currentCycleUsage: usageGuard.usage.toString(),
        accumulatedUsage: usageGuard.accumulatedUsage.toString(),
        lastUsageUpdateAt: Date.now(),
      })

      // schedule the cache update for updating usage
      this.scheduleCacheUpdateWithMaxInterval(data.featureSlug)

      return {
        success: usageGuard.success,
        message: usageGuard.message,
        usage: usageGuard.usage,
        limit: usageGuard.limit,
      }
    } catch (error) {
      this.logger.error("error reporting usage from do", {
        error: error instanceof Error ? error.message : "unknown error",
      })

      return {
        success: false,
        message: error instanceof Error ? error.message : "unknown error",
        deniedReason: "ERROR_INSERTING_USAGE_DO",
      }
    } finally {
      // clear the cache write timers
      for (const [, t] of this.cacheWriteTimers) if (t?.timerId) clearTimeout(t.timerId)
      this.cacheWriteTimers.clear()
      this.flush()
    }
  }

  private flush() {
    this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
  }

  private async ensureAlarmIsSet(flushTime?: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm()
    const now = Date.now()

    // min 5s, max 5m
    const flushSec = Math.min(Math.max(flushTime ?? this.TTL_ANALYTICS / 1000, 5), 300)
    const nextAlarm = now + flushSec * 1000

    if (!alarm) this.ctx.storage.setAlarm(nextAlarm)
    else if (alarm < now) {
      this.ctx.storage.deleteAlarm()
      this.ctx.storage.setAlarm(nextAlarm)
    }
  }

  onStart(): void | Promise<void> {
    this.logger.debug("onStart initializing do")
  }

  onConnect(): void | Promise<void> {
    this.logger.debug("onConnect")
  }

  onClose(): void | Promise<void> {
    this.logger.debug("onClose flushing metrics and logs")
    // flush the metrics and logs
    this.flush()
  }

  private async sendVerificationsToTinybird({
    featureSlug,
  }: {
    featureSlug?: string
  } = {}) {
    // Process events in batches to avoid memory issues
    const BATCH_SIZE = 500
    let processedCount = 0
    let lastProcessedId = 0

    while (true) {
      // Get a batch of events
      const verificationEvents = await this.db
        .select()
        .from(verifications)
        .where(
          and(
            lastProcessedId > 0 ? sql`id > ${lastProcessedId}` : undefined,
            featureSlug ? sql`featureSlug = ${featureSlug}` : undefined
          )
        )
        .limit(BATCH_SIZE)
        .orderBy(verifications.id)

      if (verificationEvents.length === 0) break

      const firstId = verificationEvents[0]?.id
      const lastId = verificationEvents[verificationEvents.length - 1]?.id

      if (firstId && lastId) {
        try {
          const transformedEvents = verificationEvents.map((event) => ({
            featureSlug: event.featureSlug,
            entitlementId: event.entitlementId,
            customerId: event.customerId,
            projectId: event.projectId,
            subscriptionId: event.subscriptionId,
            subscriptionPhaseId: event.subscriptionPhaseId,
            subscriptionItemId: event.subscriptionItemId,
            timestamp: event.timestamp,
            status: event.deniedReason,
            metadata: event.metadata ? JSON.parse(event.metadata) : {},
            latency: event.latency ? Number(event.latency) : 0,
            requestId: event.requestId,
            featurePlanVersionId: event.featurePlanVersionId,
            success: event.success === 1,
          }))

          await this.analytics
            .ingestFeaturesVerification(transformedEvents)
            .catch((e) => {
              this.logger.error(`Failed in ingestFeaturesVerification from do ${e.message}`, {
                error: JSON.stringify(e),
                customerId: transformedEvents[0]?.customerId,
                projectId: transformedEvents[0]?.projectId,
              })
              throw e
            })
            .then(async (data) => {
              const rows = data?.successful_rows ?? 0
              const quarantined = data?.quarantined_rows ?? 0
              const total = rows + quarantined

              if (quarantined > 0) {
                this.logger.warn("quarantined verifications", {
                  quarantined,
                })
              }

              if (total >= verificationEvents.length) {
                // Delete by range - much more efficient, only 2 SQL variables
                const deletedResult = await this.db
                  .delete(verifications)
                  .where(sql`id >= ${firstId} AND id <= ${lastId}`)
                  .returning({ id: verifications.id })

                const deletedCount = deletedResult.length
                processedCount += deletedCount

                this.logger.debug(
                  `deleted ${deletedCount} verifications from do ${this.ctx.id.toString()} (range: ${firstId}-${lastId})`,
                  {
                    rows: total,
                    deletedCount,
                    expectedCount: verificationEvents.length,
                  }
                )

                this.logger.info(`Processed ${processedCount} verifications`, {
                  customerId: transformedEvents[0]?.customerId,
                  projectId: transformedEvents[0]?.projectId,
                })
              } else {
                this.logger.debug(
                  "the total of verifications sent to tinybird are not the same as the total of verifications in the db",
                  {
                    total,
                    expected: verificationEvents.length,
                    customerId: transformedEvents[0]?.customerId,
                    projectId: transformedEvents[0]?.projectId,
                  }
                )
              }
            })
        } catch (error) {
          this.logger.error(
            `Failed to send verifications to Tinybird from do ${this.ctx.id.toString()} ${error instanceof Error ? error.message : "unknown error"}`,
            {
              error: error instanceof Error ? JSON.stringify(error) : "unknown error",
              customerId: verificationEvents[0]?.customerId,
              projectId: verificationEvents[0]?.projectId,
            }
          )
          break
        }
      }

      // Update the last processed ID for the next batch
      lastProcessedId = lastId ?? lastProcessedId
    }
  }

  private async sendUsageToTinybird({
    featureSlug,
  }: {
    featureSlug?: string
  } = {}) {
    // Process events in batches to avoid memory issues
    const BATCH_SIZE = 500
    let processedCount = 0
    let lastProcessedId = 0

    while (true) {
      // Get a batch of events
      // if featureSlug is provided, filter by featureSlug
      const events = await this.db
        .select()
        .from(usageRecords)
        .where(
          and(
            lastProcessedId > 0 ? sql`id > ${lastProcessedId}` : undefined,
            featureSlug ? sql`featureSlug = ${featureSlug}` : undefined
          )
        )
        .limit(BATCH_SIZE)
        .orderBy(usageRecords.id)

      if (events.length === 0) break

      const firstId = events[0]?.id
      const lastId = events[events.length - 1]?.id

      // Create a Map to deduplicate events based on their unique identifiers
      const uniqueEvents = new Map()
      for (const event of events) {
        // in dev we use the idempotence key and timestamp to deduplicate so we can test the usage
        const key =
          env.VERCEL_ENV === "production"
            ? `${event.idempotenceKey}`
            : `${event.idempotenceKey}-${event.timestamp}`

        if (!uniqueEvents.has(key)) {
          uniqueEvents.set(key, {
            ...event,
            metadata: event.metadata ? JSON.parse(event.metadata) : {},
            idempotenceKey: key, // override the idempotence key so we can test on analytics dev env
          })
        }
      }

      const deduplicatedEvents = Array.from(uniqueEvents.values())

      if (deduplicatedEvents.length > 0 && firstId && lastId) {
        try {
          await this.analytics
            .ingestFeaturesUsage(deduplicatedEvents)
            .catch((e) => {
              this.logger.error(
                `Failed to send ${deduplicatedEvents.length} events to Tinybird from do ${this.ctx.id.toString()}:`,
                {
                  error: e.message,
                  customerId: deduplicatedEvents[0]?.customerId,
                  projectId: deduplicatedEvents[0]?.projectId,
                }
              )
              throw e
            })
            .then(async (data) => {
              const rows = data?.successful_rows ?? 0
              const quarantined = data?.quarantined_rows ?? 0
              const total = rows + quarantined

              if (total >= deduplicatedEvents.length) {
                this.logger.debug(
                  `successfully sent ${deduplicatedEvents.length} usage records to Tinybird`,
                  {
                    rows: total,
                  }
                )

                // Delete by range - much more efficient, only 2 SQL variables
                const deletedResult = await this.db
                  .delete(usageRecords)
                  .where(sql`id >= ${firstId} AND id <= ${lastId}`)
                  .returning({ id: usageRecords.id })

                const deletedCount = deletedResult.length
                processedCount += deletedCount

                this.logger.debug(
                  `deleted ${deletedCount} usage records from do ${this.ctx.id.toString()} (range: ${firstId}-${lastId})`,
                  {
                    originalCount: events.length,
                    deduplicatedCount: deduplicatedEvents.length,
                    deletedCount,
                  }
                )
              } else {
                this.logger.debug(
                  "the total of usage records sent to tinybird are not the same as the total of usage records in the db",
                  {
                    total,
                    expected: deduplicatedEvents.length,
                    customerId: deduplicatedEvents[0]?.customerId,
                    projectId: deduplicatedEvents[0]?.projectId,
                  }
                )
              }

              this.logger.info(`Processed ${processedCount} usage events`, {
                customerId: deduplicatedEvents[0]?.customerId,
                projectId: deduplicatedEvents[0]?.projectId,
              })
            })
        } catch (error) {
          this.logger.error(
            `Failed to send events to Tinybird from do ${this.ctx.id.toString()}:`,
            {
              error: error instanceof Error ? error.message : "unknown error",
              customerId: deduplicatedEvents[0]?.customerId,
              projectId: deduplicatedEvents[0]?.projectId,
            }
          )
          break
        }
      }

      // Update the last processed ID for the next batch
      lastProcessedId = lastId ?? lastProcessedId
    }
  }

  // websocket message handler
  async onMessage(_conn: Connection, message: string) {
    this.logger.debug(`onMessage ${message}`)
  }

  public async prewarmDO({
    entitlements,
    now,
    opts,
  }: {
    entitlements: CustomerEntitlementExtended[]
    now: number
    opts?: {
      force?: boolean
    }
  }) {
    if (!this.initialized) {
      await this.initialize()
    }

    const config = await this.getConfig()
    const ttl = config.lastSyncUsageAt + this.TTL_SYNC_USAGE - now

    // force is used to prewarm the do even if the ttl is not expired
    if (ttl > 0 && !opts?.force) {
      return
    }

    // update the last sync usage at
    await this.updateConfig({
      ...config,
      lastSyncUsageAt: Date.now(),
    })

    // update entitlements in the do
    for (const entitlement of entitlements) {
      await this.updateEntitlement(entitlement)
    }
  }

  async onAlarm(): Promise<void> {
    // send usage to tinybird on alarm
    await this.sendUsageToTinybird()
    // send verifications to tinybird on alarm
    await this.sendVerificationsToTinybird()
    // flush the metrics and logs
    this.flush()
  }

  // resetDO the do used when the customer is signed out
  public async resetDO(): Promise<{
    success: boolean
    message: string
    slugs?: string[]
  }> {
    // make sure the do is initialized
    await this.initialize()

    try {
      // send the current usage and verifications to tinybird
      await this.sendUsageToTinybird()
      await this.sendVerificationsToTinybird()

      // check if the are events in the db this should be 0 latency
      const events = await this.db
        .select({
          count: count(),
        })
        .from(usageRecords)
        .then((e) => e[0])

      const verification_events = await this.db
        .select({
          count: count(),
        })
        .from(verifications)
        .then((e) => e[0])

      // if there are any events, do not delete
      if ((events?.count ?? 0) !== 0 || (verification_events?.count ?? 0) !== 0) {
        return {
          success: false,
          message: `DO has ${events?.count} events and ${verification_events?.count} verification events, can't delete.`,
        }
      }
    } catch (error) {
      this.logger.error("error resetting do", {
        error: error instanceof Error ? error.message : "unknown error",
      })
      return {
        success: false,
        message: error instanceof Error ? error.message : "unknown error",
      }
    }

    // get the entitlements from the db
    const entitlements = await this.getEntitlements()
    // get the slugs from the entitlements
    const slugs = entitlements.map((e) => e.featureSlug)

    // we are setting the state so better do it inside a block concurrency
    return await this.ctx.blockConcurrencyWhile(async () => {
      try {
        // delete the do
        await this.ctx.storage.deleteAll()

        return {
          success: true,
          message: "DO deleted",
          slugs,
        }
      } catch (error) {
        this.logger.error("error resetting do", {
          error: error instanceof Error ? error.message : "unknown error",
        })

        return {
          success: false,
          message: error instanceof Error ? error.message : "unknown error",
          deniedReason: "ERROR_RESETTING_DO",
        }
      } finally {
        this.flush()
        this.initialized = false
        this.featuresUsage.clear()
        // clear the cache write timers
        for (const [, t] of this.cacheWriteTimers) if (t?.timerId) clearTimeout(t.timerId)
        this.cacheWriteTimers.clear()
      }
    })
  }
}
