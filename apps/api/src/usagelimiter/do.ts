import { type Connection, Server } from "partyserver"

import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import type {
  EntitlementState,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { BaseError, Result } from "@unprice/error"
import { AxiomLogger, ConsoleLogger, type Logger } from "@unprice/logging"
import { CacheService } from "@unprice/services/cache"
import type { DenyReason } from "@unprice/services/customers"
import { EntitlementService } from "@unprice/services/entitlements"
import { LogdrainMetrics, type Metrics, NoopMetrics } from "@unprice/services/metrics"
import type { Env } from "~/env"
import { SqliteDOStorageProvider } from "./sqlite-do-provider"

// colo never change after the object is created
interface UsageLimiterConfig {
  colo: string
}

// This durable object takes care of handling the usage of every feature per customer.
// It is used to validate the usage of a feature and to report the usage to tinybird.
// think of it as a queue that will be flushed to the db periodically
export class DurableObjectUsagelimiter extends Server {
  // logger service
  private logger: Logger
  // entitlement service
  private entitlementService: EntitlementService
  // metrics service
  private metrics: Metrics
  // default ttl for the usage records and verifications
  private TTL_ANALYTICS = 1000 * 60 // 1 minute
  // last broadcast message time
  private LAST_BROADCAST_MSG = Date.now()
  // debounce delay for the broadcast events
  private readonly DEBOUNCE_DELAY = 1000 * 1 // 1 second (1 per second)

  // hibernate the do when no websocket nor connections are active
  static options = {
    hibernate: true,
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // set a revalidation period of 5 secs for development
    if (env.VERCEL_ENV === "development") {
      this.TTL_ANALYTICS = 1000 * 10 // 10 seconds
    }

    // set a revalidation period of 5 mins for preview
    if (env.VERCEL_ENV === "preview") {
      this.TTL_ANALYTICS = 1000 * 60 // 1 minute
    }

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
    const storage = new SqliteDOStorageProvider({
      storage: this.ctx.storage,
      state: this.ctx,
      logger: this.logger,
    })

    // initialize the storage provider if it is not initialized
    storage.initialize()

    // initialize the entitlement service
    this.entitlementService = new EntitlementService({
      db: db,
      storage: storage,
      logger: this.logger,
      analytics: new Analytics({
        emit: env.EMIT_ANALYTICS.toString() === "true",
        tinybirdToken: env.TINYBIRD_TOKEN,
        tinybirdUrl: env.TINYBIRD_URL,
        logger: this.logger,
      }),
      waitUntil: this.ctx.waitUntil,
      cache: cache,
      metrics: this.metrics,
      config: {
        revalidateInterval:
          env.NODE_ENV === "development"
            ? 60000 // 1 minute
            : 300000, // 5 minutes
        syncToDBInterval:
          env.NODE_ENV === "development"
            ? 60000 // 1 minute
            : 600000, // 10 minutes
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

  async prewarm({
    customerId,
    projectId,
    now,
  }: { customerId: string; projectId: string; now: number }) {
    // prewarm the entitlement service
    await this.entitlementService.prewarm({ customerId, projectId, now })
  }

  async getEntitlements(data: { customerId: string; projectId: string; now: number }): Promise<
    Result<EntitlementState[], BaseError>
  > {
    return await this.entitlementService.getEntitlements(data)
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
    type: "can" | "reportUsage"
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
    try {
      // All logic handled internally!
      const result = await this.entitlementService.verify(data)

      // Set alarm to flush buffers
      await this.ensureAlarmIsSet(data.flushTime)

      return result
    } catch (error) {
      const err = error as Error
      this.logger.error("error can from do", { error: err.message })
      return {
        allowed: false,
        message: err.message,
        deniedReason: "ENTITLEMENT_ERROR",
      }
    } finally {
      this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
    }
  }

  public async reportUsage(data: ReportUsageRequest): Promise<ReportUsageResult> {
    try {
      const result = await this.entitlementService.reportUsage(data)

      // Set alarm to flush buffers
      await this.ensureAlarmIsSet(data.flushTime)

      return result
    } catch (error) {
      this.logger.error("error reporting usage from do", {
        error: error instanceof Error ? error.message : "unknown error",
      })

      return {
        message: error instanceof Error ? error.message : "unknown error",
        allowed: false,
        consumedFrom: [],
      }
    } finally {
      this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
    }
  }

  // ensure the alarm is set to flush the usage records and verifications
  private async ensureAlarmIsSet(flushTime?: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm()
    const now = Date.now()

    // min 5s, max 30m
    const flushSec = Math.min(Math.max(flushTime ?? this.TTL_ANALYTICS / 1000, 5), 30 * 60)
    const nextAlarm = now + flushSec * 1000

    if (!alarm) this.ctx.storage.setAlarm(nextAlarm)
    else if (alarm < now) {
      this.ctx.storage.deleteAlarm()
      this.ctx.storage.setAlarm(nextAlarm)
    }
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
    this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
  }

  // websocket message handler
  async onMessage(_conn: Connection, message: string) {
    this.logger.debug(`onMessage ${message}`)
  }

  // when the alarm is triggered
  async onAlarm(): Promise<void> {
    // flush the metrics and logs
    this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
    // flush the usage records
    await this.entitlementService.flushUsageRecords()
    // flush the verifications (usage verifications)
    await this.entitlementService.flushVerifications()
  }
}
