import { type Connection, Server } from "partyserver"

import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import migrations from "../../drizzle/migrations"

import { Analytics } from "@unprice/analytics"
import { count, sql } from "drizzle-orm"
import { usageRecords, verifications } from "~/db/schema"
import type { schema } from "~/db/types"
import type { Env } from "~/env"
import type { CanRequest, ReportUsageRequest, ReportUsageResponse } from "./interface"

import { env } from "cloudflare:workers"
import { CloudflareStore } from "@unkey/cache/stores"
import { createConnection } from "@unprice/db"
import { type CustomerEntitlementExtended, getCurrentBillingWindow } from "@unprice/db/validators"
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
  private readonly TTL_SYNC_USAGE = 1000 * 60 * 60 * 24 // 24 hours
  // Default ttl for the revalidation of the placeholder entitlement
  private readonly TTL_PLACEHOLDER_REVALIDATION = 1000 * 60 * 5 // 5 mins
  // Debounce delay for the broadcast
  private lastBroadcastTime = 0
  // debounce delay for the broadcast events
  private readonly DEBOUNCE_DELAY = 1000 * 1 // 1 second

  // hibernate the do when no websocket nor connections are active
  static options = {
    hibernate: true,
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this.db = drizzle(ctx.storage, { logger: false })

    // set a revalidation period of 5 secs for development
    if (env.VERCEL_ENV === "development") {
      this.TTL_PLACEHOLDER_REVALIDATION = 1000 * 10 // 10 secs
    }
    // set a revalidation period of 5 mins for preview
    if (env.VERCEL_ENV === "preview") {
      this.TTL_PLACEHOLDER_REVALIDATION = 1000 * 60 * 30 // 30 secs
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
          logLevel: env.VERCEL_ENV === "production" ? "error" : "warn",
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
        this.initialized = false
        this.ctx.storage.delete("config")
      }
    })
  }

  private async getConfig(): Promise<UsageLimiterConfig> {
    const config = (await this.ctx.storage.get("config")) as UsageLimiterConfig

    // clean the config from undefined entitlements
    return {
      ...config,
      entitlements: config?.entitlements?.filter((e) => e?.id !== undefined) ?? [],
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

  private async updateEntitlement(entitlement: CustomerEntitlementExtended) {
    const config = await this.getConfig()

    let entitlementsMap = new Map<string, CustomerEntitlementExtended>()
    let entitlements = config.entitlements

    // entitlement is a placeholder don't validate
    if (entitlement.id !== "placeholder") {
      // remove the entitlement from the config and remove duplicates by featureSlug
      // if duplicate found we keep the one with the lastUpdateUsageAt the highest
      entitlements = entitlements
        .filter((e) => e.id !== entitlement.id)
        .sort((a, b) => b.lastUsageUpdateAt - a.lastUsageUpdateAt)
    }

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
    // get entitlement from memory
    let entitlement = this.featuresUsage.get(featureSlug)

    // if the entitlement is a placeholder, we need to refresh it given the TTL
    let timeToRefresh =
      entitlement && entitlement?.id === "placeholder"
        ? entitlement?.updatedAtM + this.TTL_PLACEHOLDER_REVALIDATION - now < 0
        : true

    // if the entitlement is not a placeholder, we need to check if it's outside of the current cycle window
    if (entitlement && entitlement.id !== "placeholder") {
      const currentCycleWindow = getCurrentBillingWindow({
        now: entitlement.resetedAt,
        anchor: entitlement.activePhase.billingAnchor,
        interval: entitlement.activePhase.billingConfig.billingInterval,
        intervalCount: entitlement.activePhase.billingConfig.billingIntervalCount,
        trialEndsAt: entitlement.activePhase.trialEndsAt,
      })

      timeToRefresh = now > currentCycleWindow.end || now < currentCycleWindow.start
    }

    // we can force the refresh if the forceRefresh flag is set
    const shouldRefresh = timeToRefresh ?? opts?.forceRefresh

    // If we need to refresh but we have stale data, return the stale data
    // and trigger the refresh in the background for speeding up the request
    if (shouldRefresh && entitlement && entitlement?.id !== "placeholder") {
      this.ctx.waitUntil(
        this.revalidateEntitlement({
          customerId,
          projectId,
          featureSlug,
          now,
          opts: {
            skipCache: false, // read from cache
            withLastUsage: timeToRefresh, // if the entitlement is outside of the current cycle window, we need to get the last usage
          },
        })
      )
    } else if (shouldRefresh || !entitlement) {
      // If we must refresh (no data at all),
      // then we have to block the request and wait for the result.
      const { err, val } = await this.revalidateEntitlement({
        customerId,
        projectId,
        featureSlug,
        now,
        opts: {
          skipCache: true, // force the very first refresh
          withLastUsage: true, // with the last usage
        },
      })

      if (err) {
        return Err(err)
      }

      entitlement = val
    }

    // if the entitlement doesn't need to be refreshed
    // and the entitlement is not found, return an error
    if (!entitlement?.id) {
      return Err(
        new UnPriceCustomerError({
          message: "entitlement not found",
          code: "ENTITLEMENT_NOT_FOUND",
        })
      )
    }

    // placeholder is used to avoid spamming the db with requests when entitlement is not found
    if (entitlement?.id === "placeholder") {
      return Err(
        new UnPriceCustomerError({
          message: `DO: Entitlement not found, entitlement will be refreshed in ${Math.round(
            (entitlement.updatedAtM + this.TTL_PLACEHOLDER_REVALIDATION - now) / 1000
          )} seconds`,
          code: "ENTITLEMENT_NOT_FOUND",
        })
      )
    }

    // if the entitlement is found, return the entitlement
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
      withLastUsage?: boolean
    }
  }): Promise<Result<CustomerEntitlementExtended, FetchError | UnPriceCustomerError>> {
    // if we need the last usage, we need to send the usage to tinybird
    if (opts?.withLastUsage) {
      this.logger.info("force refreshing entitlement", {
        customerId,
        projectId,
        featureSlug,
      })

      await this.sendUsageToTinybird()
      await this.sendVerificationsToTinybird()
    }

    // get the entitlement from the db
    const { err, val } = await this.customerService.getActiveEntitlement(
      customerId,
      featureSlug,
      projectId,
      now,
      {
        skipCache: opts?.skipCache ?? false,
        withLastUsage: opts?.withLastUsage ?? false,
      }
    )

    if (err) {
      // if the entitlement is not found we want to keep a placeholder
      // so in future request don't spam the db
      const placeholderEntitlement = {
        id: "placeholder",
        featureSlug: featureSlug,
        updatedAtM: Date.now(),
      } as CustomerEntitlementExtended

      await this.updateEntitlement(placeholderEntitlement)

      return Err(err)
    }

    // update the config but don't update usage if that flag is not set
    await this.updateEntitlement({
      ...val,
      updatedAtM: Date.now(),
    })

    return Ok(val)
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
        now: data.timestamp,
        opts: {
          allowOverage: false,
          autoReset: true,
        },
      })

      const latency = performance.now() - data.performanceStart

      // insert verification this is zero latency
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
        now: data.timestamp,
        opts: {
          autoReset: true, // if usage is no longer valid we reset it
        },
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
        lastUsageUpdateAt: data.timestamp,
      })

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
      this.flush()
    }
  }

  private flush() {
    this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
  }

  // instead of creating a cron job alarm we set and alarm on every request
  private async ensureAlarmIsSet(flushTime?: number): Promise<void> {
    // we set alarms to send usage to tinybird periodically
    // this would avoid having too many events in the db as well
    const alarm = await this.ctx.storage.getAlarm()
    const now = Date.now()

    // there is a default ttl for the usage records
    // alternatively we can use the flushTime from the request
    // this can be usefull if we want to support realtime usage reporting for some clients
    const nextAlarm = flushTime ? now + flushTime * 1000 : now + this.TTL_ANALYTICS

    // if there is no alarm set one given the ttl
    if (!alarm) {
      this.ctx.storage.setAlarm(nextAlarm)
    } else if (alarm < now) {
      // delete the alarm if it is in the past
      // and set it again
      this.ctx.storage.deleteAlarm()
      this.ctx.storage.setAlarm(nextAlarm)
    }
  }

  onStart(): void | Promise<void> {
    console.info("onStart initializing do")
  }

  onConnect(): void | Promise<void> {
    console.info("onConnect")
  }

  onClose(): void | Promise<void> {
    console.info("onClose flushing metrics and logs")
    // flush the metrics and logs
    this.flush()
  }

  private async sendVerificationsToTinybird() {
    // Process events in batches to avoid memory issues
    const BATCH_SIZE = 500
    let processedCount = 0
    let lastProcessedId = 0

    while (true) {
      // Get a batch of events
      const verificationEvents = await this.db
        .select()
        .from(verifications)
        .where(lastProcessedId > 0 ? sql`id > ${lastProcessedId}` : undefined)
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

                this.logger.warn(`Processed ${processedCount} verifications`, {
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

  private async sendUsageToTinybird() {
    // Process events in batches to avoid memory issues
    const BATCH_SIZE = 500
    let processedCount = 0
    let lastProcessedId = 0

    while (true) {
      // Get a batch of events
      const events = await this.db
        .select()
        .from(usageRecords)
        .where(lastProcessedId > 0 ? sql`id > ${lastProcessedId}` : undefined)
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

              this.logger.warn(`Processed ${processedCount} usage events`, {
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
    console.info("onMessage", message)
  }

  public async syncEntitlementsUsageAlarmHandler() {
    const config = await this.getConfig()
    const now = Date.now()
    const ttl = config.lastSyncUsageAt + this.TTL_SYNC_USAGE - now

    if (ttl > 0) {
      return
    }

    // project and customer id are the same for every entitlement
    const projectId = config.entitlements[0]?.projectId
    const customerId = config.entitlements[0]?.customerId

    if (!projectId || !customerId) {
      return
    }

    // update the entitlement usage in the db
    await this.customerService.syncEntitlementsUsageDB({
      customerId,
      projectId,
      now,
    })

    // update the last sync usage at
    await this.updateConfig({
      ...config,
      lastSyncUsageAt: Date.now(),
    })
  }

  async onAlarm(): Promise<void> {
    // send usage to tinybird on alarm
    await this.sendUsageToTinybird()
    // send verifications to tinybird on alarm
    await this.sendVerificationsToTinybird()
    // sync the entitlements usage in db and cache
    await this.syncEntitlementsUsageAlarmHandler()
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

    // if there are no events, delete the do
    if (events?.count !== 0 && verification_events?.count !== 0) {
      return {
        success: false,
        message: `DO has ${events?.count} events and ${verification_events?.count} verification events, can't delete.`,
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
        this.initialized = false
        this.featuresUsage.clear()

        return {
          success: true,
          message: "DO deleted",
          slugs,
        }
      } catch (error) {
        this.logger.error("error resetting do", {
          error: error instanceof Error ? error.message : "unknown error",
        })

        this.initialized = false
        this.featuresUsage.clear()

        return {
          success: false,
          message: error instanceof Error ? error.message : "unknown error",
          deniedReason: "ERROR_RESETTING_DO",
        }
      } finally {
        this.flush()
      }
    })
  }
}
