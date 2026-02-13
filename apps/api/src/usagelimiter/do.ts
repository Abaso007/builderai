import type { R2Bucket } from "@cloudflare/workers-types"
import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import type {
  CurrentUsage,
  MinimalEntitlement,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { BaseError, Result } from "@unprice/error"
import {
  AxiomLogger,
  ConsoleLogger,
  type Logger,
  type WideEventLogger,
  createWideEventHelpers,
  createWideEventLogger,
} from "@unprice/logging"
import { shouldEmitLogsToBackend, shouldEmitMetrics } from "@unprice/logging/env"
import { CacheService } from "@unprice/services/cache"
import type { DenyReason } from "@unprice/services/customers"
import { EntitlementService } from "@unprice/services/entitlements"
import { LogdrainMetrics, type Metrics, NoopMetrics } from "@unprice/services/metrics"
import { type Connection, Server } from "partyserver"
import type { Env } from "~/env"
import type { BufferMetricsResponse } from "./interface"
import { type FlushPressureStats, SqliteDOStorageProvider } from "./sqlite-do-provider"

// colo never change after the object is created
interface UsageLimiterConfig {
  colo: string
}

type UsageInputSummary = {
  customerId: string
  projectId: string
  featureSlug: string
  usage?: number
  timestamp: number
  flushTime?: number
  sync?: boolean
  action?: string
  keyId?: string
  country?: string
  region?: string
  metadataKeyCount?: number
  metadataKeySample?: string
}

type UsageResultSummary = {
  allowed: boolean
  message?: string
  deniedReason?: string
  featureType?: string
  cacheHit?: boolean
  remaining?: number
  limit?: number
  usage?: number
  cost?: number
  latency?: number
  notifiedOverLimit?: boolean
  degraded?: boolean
  degradedReason?: string
}

const METADATA_KEY_SAMPLE_LIMIT = 10

const summarizeUsageInput = (data: VerifyRequest | ReportUsageRequest): UsageInputSummary => {
  const metadataKeys = data.metadata ? Object.keys(data.metadata) : []
  const metadataKeySample = metadataKeys.slice(0, METADATA_KEY_SAMPLE_LIMIT).join(",")

  return {
    customerId: data.customerId,
    projectId: data.projectId,
    featureSlug: data.featureSlug,
    usage: data.usage,
    timestamp: data.timestamp,
    flushTime: data.flushTime,
    sync: "sync" in data ? data.sync : undefined,
    action: data.action,
    keyId: data.keyId,
    country: data.country,
    region: data.region,
    metadataKeyCount: metadataKeys.length || undefined,
    metadataKeySample: metadataKeySample || undefined,
  }
}

const summarizeUsageResult = (
  result: VerificationResult | ReportUsageResult
): UsageResultSummary => {
  return {
    allowed: result.allowed,
    message: result.message,
    deniedReason: result.deniedReason,
    featureType: "featureType" in result ? result.featureType : undefined,
    cacheHit: result.cacheHit,
    remaining: result.remaining,
    limit: result.limit,
    usage: result.usage,
    cost: result.cost,
    latency: "latency" in result ? result.latency : undefined,
    notifiedOverLimit: "notifiedOverLimit" in result ? result.notifiedOverLimit : undefined,
    degraded: result.degraded,
    degradedReason: result.degradedReason,
  }
}

// This durable object takes care of handling the usage of every feature per customer.
// It is used to validate the usage of a feature and to report the usage to tinybird.
// think of it as a queue that will be flushed to the db periodically
export class DurableObjectUsagelimiter extends Server {
  // environment variables
  private readonly _env: Env
  // logger service
  private logger: Logger
  // entitlement service
  private entitlementService: EntitlementService
  // storage provider
  private storage: SqliteDOStorageProvider
  // metrics service
  private metrics: Metrics
  // default ttl for the usage records and verifications
  private TTL_ANALYTICS = 1000 * 60 // 1 minute
  // last broadcast message time
  private LAST_BROADCAST_MSG = Date.now()
  // debounce delay for the broadcast events
  private readonly DEBOUNCE_DELAY = 1000 * 1 // 1 second (1 per second)
  // sample rate for the wide event
  private SAMPLE_RATE = 0.1
  private readonly FLUSH_SEC_MIN = 5
  private readonly FLUSH_SEC_MAX = 30 * 60

  // hibernate the do when no websocket nor connections are active
  static options = {
    hibernate: true,
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this._env = env

    // set a revalidation period of 5 secs for development
    if (env.APP_ENV === "development") {
      this.TTL_ANALYTICS = 1000 * 10 // 10 seconds
      this.SAMPLE_RATE = 1
    }

    // set a revalidation period of 5 mins for preview
    if (env.APP_ENV === "preview") {
      this.TTL_ANALYTICS = 1000 * 60 // 1 minute
      this.SAMPLE_RATE = 0.1
    }

    const emitLogsToBackend = shouldEmitLogsToBackend(env)
    const emitMetrics = shouldEmitMetrics(env)

    this.logger = emitLogsToBackend
      ? new AxiomLogger({
          apiKey: env.AXIOM_API_TOKEN,
          dataset: env.AXIOM_DATASET,
          requestId: this.ctx.id.toString(),
          logLevel: env.APP_ENV === "production" ? "warn" : "info",
          environment: env.NODE_ENV,
          service: "usagelimiter",
          defaultFields: {
            durableObjectId: this.ctx.id.toString(),
            version: this._env.VERSION,
          },
        })
      : new ConsoleLogger({
          requestId: this.ctx.id.toString(),
          service: "usagelimiter",
          environment: env.NODE_ENV,
          logLevel: env.APP_ENV === "production" ? "warn" : "info",
          defaultFields: {
            durableObjectId: this.ctx.id.toString(),
            version: this._env.VERSION,
          },
        })

    this.metrics = emitMetrics
      ? new LogdrainMetrics({
          requestId: this.ctx.id.toString(),
          environment: env.NODE_ENV,
          logger: this.logger,
          service: "usagelimiter",
          durableObjectId: this.ctx.id.toString(),
          sampleRate: 1,
        })
      : new NoopMetrics()

    const cacheService = new CacheService(
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
      env.CLOUDFLARE_CACHE_DOMAIN &&
      env.CLOUDFLARE_ZONE_ID !== "" &&
      env.CLOUDFLARE_API_TOKEN !== "" &&
      env.CLOUDFLARE_CACHE_DOMAIN !== ""
        ? new CloudflareStore({
            cloudflareApiKey: env.CLOUDFLARE_API_TOKEN,
            zoneId: env.CLOUDFLARE_ZONE_ID,
            domain: env.CLOUDFLARE_CACHE_DOMAIN,
            cacheBuster: "v2",
          })
        : undefined

    const stores = []

    // push the cloudflare store first to hit it first
    if (cloudflareCacheStore) {
      stores.push(cloudflareCacheStore)
    }

    // register the cloudflare store if it is configured
    cacheService.init(stores)

    const cache = cacheService.getCache()

    const db = createConnection({
      env: env.NODE_ENV,
      primaryDatabaseUrl: env.DATABASE_URL,
      read1DatabaseUrl: env.DATABASE_READ1_URL,
      read2DatabaseUrl: env.DATABASE_READ2_URL,
      logger: env.DRIZZLE_LOG.toString() === "true",
      singleton: false, // Don't use singleton for hibernating DOs
    })

    // initialize the storage provider
    this.storage = new SqliteDOStorageProvider({
      storage: this.ctx.storage,
      state: this.ctx,
      logger: this.logger,
      analytics: new Analytics({
        emit: true,
        tinybirdToken: env.TINYBIRD_TOKEN,
        tinybirdUrl: env.TINYBIRD_URL,
        logger: this.logger,
      }),
      lakehouse: env.LAKEHOUSE as unknown as R2Bucket,
    })

    // initialize the storage provider - must block until complete
    // If initialization fails (e.g., schema version changed), reset storage and retry
    this.ctx.blockConcurrencyWhile(async () => {
      const result = await this.storage.initialize()
      if (result.err) {
        this.logger.warn("Storage initialization failed, resetting storage", {
          error: result.err.message,
        })
        // reset the storage and retry initialization - this is a last resort
        await this.ctx.storage.deleteAll()
        const retryResult = await this.storage.initialize()
        if (retryResult.err) {
          this.logger.error("Storage initialization failed after reset", {
            error: retryResult.err.message,
          })
        }
      }
    })

    // initialize the entitlement service
    this.entitlementService = new EntitlementService({
      db: db,
      storage: this.storage,
      logger: this.logger,
      analytics: new Analytics({
        emit: true,
        tinybirdToken: env.TINYBIRD_TOKEN,
        tinybirdUrl: env.TINYBIRD_URL,
        logger: this.logger,
      }),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      cache: cache,
      metrics: this.metrics,
      config: {
        revalidateInterval:
          env.NODE_ENV === "development"
            ? 30000 // 30 seconds
            : 300000, // 5 minutes
      },
    })

    // set the colo of the do
    this.setColo()
  }

  // set colo for metrics and analytics
  async setColo() {
    const config = await this.getConfig()

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

  private async getConfig(): Promise<UsageLimiterConfig> {
    const raw = (await this.ctx.storage.get("config")) as UsageLimiterConfig | undefined
    return {
      colo: raw?.colo ?? "",
    }
  }

  private async updateConfig(config: UsageLimiterConfig) {
    await this.ctx.storage.put("config", {
      ...config,
    })
  }

  public async getCurrentUsage(data: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<CurrentUsage, BaseError>> {
    return await this.entitlementService.getCurrentUsage({
      ...data,
    })
  }

  public async resetEntitlements(params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    return await this.entitlementService.resetEntitlements({
      customerId: params.customerId,
      projectId: params.projectId,
    })
  }

  public async getActiveEntitlements(params: {
    customerId: string
    projectId: string
  }): Promise<Result<MinimalEntitlement[], BaseError>> {
    return await this.entitlementService.getActiveEntitlements({
      customerId: params.customerId,
      projectId: params.projectId,
    })
  }

  public async getBufferMetrics(data?: {
    windowSeconds?: 300 | 3600 | 86400 | 604800
  }): Promise<Result<BufferMetricsResponse, BaseError>> {
    return await this.storage.getBufferStats(data?.windowSeconds)
  }

  // when connected through websocket we can broadcast events to the client
  // realtime events are used to debug events in dashboard
  async broadcastEvents(data: {
    customerId: string
    featureSlug: string
    deniedReason?: DenyReason
    usage?: number
    limit?: number
    notifyUsage?: boolean
    type: "verify" | "reportUsage"
    success: boolean
  }) {
    const now = Date.now()

    // Only broadcast if enough time has passed since last broadcast
    // defailt 1 per second
    // this is used to debug events in real time in dashboard
    if (now - this.LAST_BROADCAST_MSG >= this.DEBOUNCE_DELAY) {
      // under the hood this validates if there are connections
      // and sends the event to all of them
      this.broadcast(JSON.stringify(data))
      this.LAST_BROADCAST_MSG = now
    }
  }

  public async verify(data: VerifyRequest): Promise<VerificationResult> {
    const wideEventLogger = createWideEventLogger({
      "service.name": "usagelimiter",
      "service.version": this._env.VERSION,
      "service.environment": this._env.NODE_ENV as
        | "production"
        | "staging"
        | "development"
        | "preview"
        | "test",
      sampleRate: this.SAMPLE_RATE,
      emitter: (level, message, event) => this.logger.emit(level, message, event),
    })

    const wideEventHelpers = createWideEventHelpers(wideEventLogger)

    return await wideEventLogger.runAsync(async () => {
      try {
        // set the wide event helpers
        this.entitlementService.setWideEventHelpers(wideEventHelpers)

        // set the request id for the metrics and logs
        this.logger.x(data.requestId)
        this.metrics.x(data.requestId)
        wideEventLogger.add("request.id", data.requestId) // We don't need to generate a new id for the DO request
        wideEventLogger.add("request.timestamp", new Date().toISOString())
        wideEventHelpers.addParentRequestId(data.requestId) // Link to parent
        wideEventHelpers.addCloud({
          platform: "cloudflare",
          durable_object_id: this.ctx.id.toString(),
          region: this.metrics.getColo(),
        })
        wideEventLogger.add("usagelimiter.operation", "verify")
        wideEventLogger.add("usagelimiter.input", summarizeUsageInput(data))
        // All logic handled internally!
        const result = await this.entitlementService.verify(data)
        wideEventLogger.add("usagelimiter.result", summarizeUsageResult(result))
        // Set alarm to flush buffers
        await this.ensureAlarmIsSet(wideEventLogger, data.flushTime)

        this.ctx.waitUntil(
          this.broadcastEvents({
            customerId: data.customerId,
            featureSlug: data.featureSlug,
            type: "verify",
            success: result.allowed,
            deniedReason: result.deniedReason as DenyReason | undefined,
            usage: result.usage,
            limit: result.limit,
          })
        )

        return result
      } catch (error) {
        const err = error as Error
        wideEventLogger.addError(err)
        return {
          allowed: false,
          message: err.message,
          deniedReason: "ENTITLEMENT_ERROR",
        }
      } finally {
        wideEventLogger.add("request.duration", Date.now() - data.performanceStart)
        this.ctx.waitUntil(
          (async () => {
            try {
              await Promise.all([
                // only log if the event should be sampled
                wideEventLogger.emit(),
                this.metrics.flush().catch((err: Error) => {
                  console.error("Failed to flush metrics in DO", err)
                }),
                this.logger.flush().catch((err: Error) => {
                  console.error("Failed to flush logger in DO", err)
                }),
              ])
            } catch (error) {
              console.error("Error during background flush in DO", error)
            }
          })()
        )
      }
    })
  }

  public async reportUsage(data: ReportUsageRequest): Promise<ReportUsageResult> {
    const wideEventLogger = createWideEventLogger({
      "service.name": "usagelimiter",
      "service.version": this._env.VERSION,
      "service.environment": this._env.NODE_ENV as
        | "production"
        | "staging"
        | "development"
        | "preview"
        | "test",
      sampleRate: this.SAMPLE_RATE,
      emitter: (level, message, event) => this.logger.emit(level, message, event),
    })

    const wideEventHelpers = createWideEventHelpers(wideEventLogger)

    return await wideEventLogger.runAsync(async () => {
      try {
        // set the wide event helpers
        this.entitlementService.setWideEventHelpers(wideEventHelpers)

        // set the request id for the metrics and logs
        this.logger.x(data.requestId)
        this.metrics.x(data.requestId)

        wideEventLogger.add("request.id", data.requestId)
        wideEventLogger.add("request.timestamp", new Date().toISOString())
        wideEventHelpers.addParentRequestId(data.requestId)
        wideEventHelpers.addCloud({
          platform: "cloudflare",
          durable_object_id: this.ctx.id.toString(),
          region: this.metrics.getColo(),
        })
        wideEventLogger.add("usagelimiter.operation", "reportUsage")
        wideEventLogger.add("usagelimiter.input", summarizeUsageInput(data))

        const result = await this.entitlementService.reportUsage(data)
        wideEventLogger.add("usagelimiter.result", summarizeUsageResult(result))
        // Set alarm to flush buffers
        await this.ensureAlarmIsSet(wideEventLogger, data.flushTime)

        this.ctx.waitUntil(
          this.broadcastEvents({
            customerId: data.customerId,
            featureSlug: data.featureSlug,
            type: "reportUsage",
            success: result.allowed,
            deniedReason: result.deniedReason as DenyReason | undefined,
            usage: result.usage,
            limit: result.limit,
          })
        )

        return result
      } catch (error) {
        const err = error as Error
        wideEventLogger.addError(err)

        return {
          message: error instanceof Error ? error.message : "unknown error",
          allowed: false,
        }
      } finally {
        data.performanceStart &&
          wideEventLogger.add("request.duration", Date.now() - data.performanceStart)

        this.ctx.waitUntil(
          (async () => {
            try {
              await Promise.all([
                // only log if the event should be sampled
                wideEventLogger.emit(),
                this.metrics.flush().catch((err: Error) => {
                  console.error("Failed to flush metrics in DO", err)
                }),
                this.logger.flush().catch((err: Error) => {
                  console.error("Failed to flush logger in DO", err)
                }),
              ])
            } catch (error) {
              console.error("Error during background flush in DO", error)
            }
          })()
        )
      }
    })
  }

  // ensure the alarm is set to flush the usage records and verifications
  private async ensureAlarmIsSet(
    wideEventLogger: WideEventLogger,
    flushTime?: number
  ): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm()
    const now = Date.now()

    const fallbackFlushSec = this.normalizeFlushSeconds(flushTime)

    if (alarm && alarm <= now + fallbackFlushSec * 1000) {
      wideEventLogger.add("usagelimiter.next_alarm", new Date(alarm).toISOString())
      return
    }

    const pressure = await this.getFlushPressureSafe()
    const adaptiveFlushSec = this.getAdaptiveFlushSeconds(pressure, fallbackFlushSec)
    const nextAlarm = now + adaptiveFlushSec * 1000

    wideEventLogger.add("usagelimiter.next_alarm", new Date(nextAlarm).toISOString())
    if (!alarm || nextAlarm < alarm) {
      this.ctx.storage.setAlarm(nextAlarm)
    }
  }

  private normalizeFlushSeconds(flushTime?: number): number {
    return Math.min(
      Math.max(flushTime ?? this.TTL_ANALYTICS / 1000, this.FLUSH_SEC_MIN),
      this.FLUSH_SEC_MAX
    )
  }

  private getAdaptiveFlushSeconds(
    pressure: FlushPressureStats | null,
    fallbackFlushSec: number
  ): number {
    if (!pressure) {
      return fallbackFlushSec
    }

    let adaptive = fallbackFlushSec

    if (pressure.pendingTotalRecords >= 20000) {
      adaptive = Math.min(adaptive, 5)
    } else if (pressure.pendingTotalRecords >= 10000) {
      adaptive = Math.min(adaptive, 10)
    } else if (pressure.pendingTotalRecords >= 5000) {
      adaptive = Math.min(adaptive, 15)
    } else if (pressure.pendingTotalRecords >= 2000) {
      adaptive = Math.min(adaptive, 30)
    } else if (pressure.pendingTotalRecords >= 500) {
      adaptive = Math.min(adaptive, 45)
    }

    if (pressure.oldestPendingAgeSeconds >= 5 * 60) {
      adaptive = Math.min(adaptive, 10)
    }

    return Math.min(Math.max(adaptive, this.FLUSH_SEC_MIN), this.FLUSH_SEC_MAX)
  }

  private async getFlushPressureSafe(): Promise<FlushPressureStats | null> {
    const { err, val } = await this.storage.getFlushPressure()
    if (err) {
      this.logger.warn("Unable to read flush pressure", { error: err.message })
      return null
    }
    return val
  }

  // websocket events handlers
  onStart(): void | Promise<void> {
    this.logger.debug("onStart initializing do")
  }

  // when a websocket connection is established
  onConnect(): void | Promise<void> {
    this.logger.debug("onConnect")
  }

  // when a websocket connection is closed
  onClose(): void | Promise<void> {
    // flush the metrics and logs
    this.ctx.waitUntil(
      (async () => {
        try {
          await Promise.all([
            this.metrics.flush().catch((err: Error) => {
              console.error("Failed to flush metrics in DO onClose", err)
            }),
            this.logger.flush().catch((err: Error) => {
              console.error("Failed to flush logger in DO onClose", err)
            }),
          ])
        } catch (error) {
          console.error("Error during background flush in DO onClose", error)
        }
      })()
    )
  }

  // websocket message handler
  async onMessage(conn: Connection, message: string) {
    try {
      const parsed = JSON.parse(message) as {
        type?: "snapshot_request"
        windowSeconds?: 300 | 3600 | 86400 | 604800
      }

      if (parsed.type === "snapshot_request") {
        const { err, val } = await this.getBufferMetrics({
          windowSeconds: parsed.windowSeconds,
        })

        if (err) {
          conn.send(
            JSON.stringify({
              type: "snapshot_error",
              message: err.message,
            })
          )
          return
        }

        conn.send(
          JSON.stringify({
            type: "snapshot",
            metrics: val,
            source: "durable_object",
          })
        )
      }
    } catch {
      this.logger.debug(`onMessage ${message}`)
    }
  }

  // when the alarm is triggered
  async onAlarm(): Promise<void> {
    this.logger.debug("Triggering alarm flush")
    // flush the usage records
    await this.entitlementService.flush()

    const pressure = await this.getFlushPressureSafe()

    if (pressure && pressure.pendingTotalRecords > 0) {
      const now = Date.now()
      const adaptiveFlushSec = this.getAdaptiveFlushSeconds(pressure, this.TTL_ANALYTICS / 1000)
      this.ctx.storage.setAlarm(now + adaptiveFlushSec * 1000)

      this.logger.info("Scheduled follow-up flush under pressure", {
        pendingTotalRecords: pressure.pendingTotalRecords,
        oldestPendingAgeSeconds: pressure.oldestPendingAgeSeconds,
        nextFlushSeconds: adaptiveFlushSec,
      })
    }

    // flush the metrics and logs
    this.ctx.waitUntil(
      (async () => {
        try {
          await Promise.all([
            this.metrics.flush().catch((err: Error) => {
              console.error("Failed to flush metrics in DO onAlarm", err)
            }),
            this.logger.flush().catch((err: Error) => {
              console.error("Failed to flush logger in DO onAlarm", err)
            }),
          ])
        } catch (error) {
          console.error("Error during background flush in DO onAlarm", error)
        }
      })()
    )
  }
}
