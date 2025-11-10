import { type Connection, Server } from "partyserver"

import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import migrations from "../../drizzle/migrations"

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
import { AxiomLogger, ConsoleLogger, type Logger } from "@unprice/logging"
import { CacheService } from "@unprice/services/cache"
import type { DenyReason } from "@unprice/services/customers"
import { EntitlementService } from "@unprice/services/entitlements"
import { LogdrainMetrics, type Metrics, NoopMetrics } from "@unprice/services/metrics"
import type { schema } from "~/db/types"
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
  // if the do is initialized
  private initialized = false
  // once the durable object is initialized we can avoid
  // querying the db for usage on each request
  private featuresUsage: Map<string, EntitlementState> = new Map()
  // internal database of the do
  private db: DrizzleSqliteDODatabase<typeof schema>
  // logger
  private logger: Logger
  // entitlement service
  private entitlementService: EntitlementService
  // metrics
  private metrics: Metrics
  // Default ttl for the usage records and verifications
  private TTL_ANALYTICS = 1000 * 60 // 1 minute
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

    // ADD: Initialize storage provider with your tables
    const storage = new SqliteDOStorageProvider(this.db, this.ctx.storage, this.logger)

    // ADD: Initialize entitlement service
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
      },
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
        const { err, val: entitlements } = await this.entitlementService.storage.getAll()

        if (err) {
          this.logger.error("error getting entitlements", {
            error: err.message,
          })
          return
        }

        // user can't have the same feature slug at the same time
        entitlements.forEach((e: EntitlementState) => {
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

  async prewarm({
    customerId,
    projectId,
    now,
  }: { customerId: string; projectId: string; now: number }) {
    await this.initialize()

    // if not initialized, return
    if (!this.initialized) {
      return
    }

    // prewarm the entitlement service
    await this.entitlementService.prewarm({ customerId, projectId, now })
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

  public async verify(data: VerifyRequest): Promise<VerificationResult> {
    try {
      // make sure the do is initialized
      await this.initialize()

      // check if all the DO is initialized
      if (!this.initialized) {
        return {
          allowed: false,
          message: "DO not initialized",
          deniedReason: "DO_NOT_INITIALIZED",
        }
      }

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
      await this.initialize()

      if (!this.initialized) {
        return {
          allowed: false,
          message: "DO not initialized",
          deniedReason: "DO_NOT_INITIALIZED",
          consumedFrom: [],
        }
      }

      // All logic handled internally!
      // - Gets entitlement from cache/DB
      // - Validates usage
      // - Consumes grants by priority
      // - Buffers with grant attribution
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
    // flush the metrics and logs
    this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
  }

  // websocket message handler
  async onMessage(_conn: Connection, message: string) {
    this.logger.debug(`onMessage ${message}`)
  }

  async onAlarm(): Promise<void> {
    // flush the metrics and logs
    this.ctx.waitUntil(Promise.all([this.metrics.flush(), this.logger.flush()]))
    // flush the entitlement service
    await this.entitlementService.flushUsageRecords()
    // flush the verifications
    await this.entitlementService.flushVerifications()
  }
}
