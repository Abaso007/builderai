import { DurableObject } from "cloudflare:workers"
import {
  Analytics,
  type AnalyticsEntitlementMeterFact,
  entitlementMeterFactSchemaV1,
} from "@unprice/analytics"
import type { OverageStrategy } from "@unprice/db/validators"
import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type Fact,
  MAX_EVENT_AGE_MS,
  type MeterConfig,
  type RawEvent,
} from "@unprice/services/entitlements"
import { asc, eq, inArray, lt, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { apiDrain } from "~/observability"
import { idempotencyKeysTable, meterFactsOutboxTable, meterStateTable } from "./db/schema"
import { schema } from "./db/schema"
import { DrizzleStorageAdapter } from "./drizzle-adapter"
import migrations from "./drizzle/migrations"
import { findLimitExceededFact } from "./limit-policy"

const VALID_OVERAGE_STRATEGIES = new Set<OverageStrategy>(["none", "last-call", "always"])

class EntitlementWindowLimitExceededError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterId: string
      limit: number
      valueAfter: number
    }
  ) {
    super(`Limit exceeded for meter ${params.meterId}`)
    this.name = EntitlementWindowLimitExceededError.name
  }
}

type ApplyInput = {
  event: RawEvent
  idempotencyKey: string
  projectId: string
  customerId: string
  streamId: string
  featureSlug: string
  periodKey: string
  meters: MeterConfig[]
  limit?: number | null
  overageStrategy?: OverageStrategy
  enforceLimit: boolean
}

type ApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED"
  message?: string
}

type OutboxBatchRow = {
  id: number
  payload: string
}

export class EntitlementWindowDO extends DurableObject {
  private readonly analytics: Analytics
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly fallbackAnalytics: AnalyticsEngineDataset | null
  private readonly logger: AppLogger
  private readonly ready: Promise<void>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    const requestId = this.ctx.id.toString()
    const { logger } = createStandaloneRequestLogger(
      {
        requestId,
      },
      {
        flush: apiDrain?.flush,
      }
    )

    this.logger = logger
    this.logger.set({
      requestId,
      service: "entitlementwindow",
      request: {
        id: requestId,
      },
      cloud: {
        platform: "cloudflare",
        durable_object_id: requestId,
      },
    })

    this.analytics = new Analytics({
      emit: true,
      tinybirdToken: env.TINYBIRD_TOKEN,
      tinybirdUrl: env.TINYBIRD_URL,
      logger: this.logger,
    })
    this.fallbackAnalytics = env.FALLBACK_ANALYTICS ?? null

    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations)
    })
  }

  public async apply(input: ApplyInput): Promise<ApplyResult> {
    await this.ready

    // 1. validate the input
    this.assertValidInput(input)
    // The DO has a idempotency key per period to deduplicate
    const idempotencyKey = input.idempotencyKey
    const createdAt = Date.now()

    let insertedFactCount = 0

    try {
      // fan out pattern to avoid losing events if the transaction fails
      const result = this.db.transaction((tx) => {
        const existing = tx
          .select({ result: idempotencyKeysTable.result })
          .from(idempotencyKeysTable)
          .where(eq(idempotencyKeysTable.eventId, idempotencyKey))
          .get()

        if (existing?.result) {
          // if exist we don't reprocess the meter
          return this.parseStoredResult(existing.result)
        }

        try {
          // create the adapter and the engine
          const adapter = new DrizzleStorageAdapter(tx)
          // create the engine
          const engine = new AsyncMeterAggregationEngine(input.meters, adapter)
          // apply the event
          const facts = engine.applyEventSync(input.event, {
            // A limit hit is still a valid ingestion event. We store the denied
            // result in the DO idempotency table so queue retries stay stable,
            // while the ingestion service treats the event as processed.
            beforePersist: (pendingFacts) => {
              // only enforce the limits when needed
              if (!input.enforceLimit) {
                return
              }

              const exceeded = findLimitExceededFact({
                facts: pendingFacts,
                limit: input.limit,
                overageStrategy: input.overageStrategy,
              })

              if (exceeded && typeof input.limit === "number" && Number.isFinite(input.limit)) {
                throw new EntitlementWindowLimitExceededError({
                  eventId: input.event.id,
                  meterId: exceeded.meterId,
                  limit: input.limit,
                  valueAfter: exceeded.valueAfter,
                })
              }
            },
          })

          insertedFactCount = facts.length
          const meterConfigsById = new Map(input.meters.map((meter) => [meter.eventId, meter]))

          // create the outbox batch of facts
          for (const fact of facts) {
            const meterConfig = meterConfigsById.get(fact.meterId)

            if (!meterConfig) {
              throw new Error(`Missing meter config for fact meter ${fact.meterId}`)
            }

            const payload = this.buildOutboxFactPayload({
              createdAt,
              fact,
              input,
              meterConfig,
            })

            tx.insert(meterFactsOutboxTable)
              .values({ payload: JSON.stringify(payload) })
              .run()
          }

          const successResult: ApplyResult = { allowed: true }

          tx.insert(idempotencyKeysTable)
            .values({
              eventId: idempotencyKey,
              createdAt,
              result: JSON.stringify(successResult),
            })
            .run()

          return successResult
        } catch (error) {
          if (error instanceof EntitlementWindowLimitExceededError) {
            const deniedResult: ApplyResult = {
              allowed: false,
              deniedReason: "LIMIT_EXCEEDED",
              message: error.message,
            }

            tx.insert(idempotencyKeysTable)
              .values({
                eventId: idempotencyKey,
                createdAt,
                result: JSON.stringify(deniedResult),
              })
              .run()

            return deniedResult
          }

          throw error
        }
      })

      // if there are facts inserted lets set an alarm to flush to analytics
      if (result.allowed && insertedFactCount > 0) {
        // set the alarm to flush the outbox to tinybird
        const currentAlarm = await this.ctx.storage.getAlarm()
        if (currentAlarm === null) {
          await this.ctx.storage.setAlarm(Date.now() + 30_000) // every 30secs
        }
      }

      return result
    } catch (error) {
      if (
        error instanceof EventTimestampTooFarInFutureError ||
        error instanceof EventTimestampTooOldError
      ) {
        throw error
      }

      throw error
    }
  }

  public async getEnforcementState(input: {
    limit?: number | null
    meterId: string
    overageStrategy?: OverageStrategy | null
  }): Promise<{
    isLimitReached: boolean
    limit: number | null
    usage: number
  }> {
    await this.ready

    const stateRow = this.db
      .select({
        value: meterStateTable.value,
      })
      .from(meterStateTable)
      .where(eq(meterStateTable.key, this.makeMeterStateKey(input.meterId)))
      .get()

    const usage = Number(stateRow?.value ?? 0)
    const limit = this.normalizeLimit(input.limit)
    const isLimitReached =
      typeof limit === "number" &&
      Number.isFinite(limit) &&
      input.overageStrategy !== "always" &&
      usage >= limit

    return {
      usage,
      limit,
      isLimitReached,
    }
  }

  async alarm(): Promise<void> {
    await this.ready

    const batch = this.db
      .select({
        id: meterFactsOutboxTable.id,
        payload: meterFactsOutboxTable.payload,
      })
      .from(meterFactsOutboxTable)
      .orderBy(asc(meterFactsOutboxTable.id))
      .limit(1000)
      .all()

    if (batch.length > 0) {
      // this needs to be reliable and idempotent
      const flushed = await this.flushToTinybird(batch)
      if (flushed) {
        // delete the outbox records with cursor based deletion
        this.db
          .delete(meterFactsOutboxTable)
          .where(
            inArray(
              meterFactsOutboxTable.id,
              batch.map((row) => row.id)
            )
          )
          .run()
      }
    }

    // we need to keep to idempotency keys for the same period as late arrival of events meaning 30 days
    this.db
      .delete(idempotencyKeysTable)
      .where(lt(idempotencyKeysTable.createdAt, Date.now() - MAX_EVENT_AGE_MS)) // 30 days
      .run()

    const remainingOutboxCount = this.getOutboxCount()
    // after the entitlement end we give 30 days to self destruct
    const selfDestructAt = this.getPeriodEndMs() + MAX_EVENT_AGE_MS // 30 days

    // delete the DO if the period is over and there are no remaining outbox records
    if (Date.now() > selfDestructAt && remainingOutboxCount === 0) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }

    if (remainingOutboxCount > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      return
    }

    await this.ctx.storage.setAlarm(selfDestructAt)
  }

  private assertValidInput(input: ApplyInput): void {
    const hasValidLimit =
      input.limit === undefined ||
      input.limit === null ||
      (typeof input.limit === "number" && Number.isFinite(input.limit))

    const hasValidOverageStrategy =
      input.overageStrategy === undefined || VALID_OVERAGE_STRATEGIES.has(input.overageStrategy)
    const hasValidIdempotencyKey =
      typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
    const hasValidContext =
      typeof input.projectId === "string" &&
      input.projectId.length > 0 &&
      typeof input.customerId === "string" &&
      input.customerId.length > 0 &&
      typeof input.streamId === "string" &&
      input.streamId.length > 0 &&
      typeof input.featureSlug === "string" &&
      input.featureSlug.length > 0 &&
      typeof input.periodKey === "string" &&
      input.periodKey.length > 0

    if (
      !input ||
      !input.event ||
      !hasValidIdempotencyKey ||
      !hasValidContext ||
      !Array.isArray(input.meters) ||
      !hasValidLimit ||
      !hasValidOverageStrategy
    ) {
      throw new TypeError("Invalid apply payload")
    }
  }

  private parseStoredResult(result: string): ApplyResult {
    const parsed = JSON.parse(result) as Partial<ApplyResult>
    return {
      allowed: parsed.allowed === true,
      deniedReason: parsed.deniedReason,
      message: parsed.message,
    }
  }

  private buildOutboxFactPayload(params: {
    createdAt: number
    fact: Fact
    input: ApplyInput
    meterConfig: MeterConfig
  }): AnalyticsEntitlementMeterFact {
    const { createdAt, fact, input, meterConfig } = params

    return entitlementMeterFactSchemaV1.parse({
      id: [input.streamId, input.periodKey, input.event.id, fact.meterId].join(":"),
      event_id: input.event.id,
      idempotency_key: input.idempotencyKey,
      project_id: input.projectId,
      customer_id: input.customerId,
      entitlement_id: input.streamId,
      feature_slug: input.featureSlug,
      period_key: input.periodKey,
      event_slug: input.event.slug,
      aggregation_method: meterConfig.aggregationMethod,
      meter_id: fact.meterId,
      timestamp: input.event.timestamp,
      created_at: createdAt,
      delta: fact.delta,
      value_after: fact.valueAfter,
    })
  }

  private parseOutboxFactPayload(payload: string): AnalyticsEntitlementMeterFact {
    return entitlementMeterFactSchemaV1.parse(JSON.parse(payload))
  }

  private async flushToTinybird(batch: OutboxBatchRow[]): Promise<boolean> {
    let facts: AnalyticsEntitlementMeterFact[]

    try {
      facts = batch.map((row) => this.parseOutboxFactPayload(row.payload))
    } catch (error) {
      this.logger.error("Failed to parse entitlement meter fact outbox payload", {
        error: this.errorMessage(error),
        batchSize: batch.length,
      })
      return false
    }

    try {
      const result = await this.analytics.ingestEntitlementMeterFacts(facts)
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0

      if (successful === facts.length && quarantined === 0) {
        return true
      }

      this.logger.error("Tinybird entitlement meter facts ingestion failed", {
        expected: facts.length,
        successful,
        quarantined,
      })
    } catch (error) {
      this.logger.error("Failed to ingest entitlement meter facts to Tinybird", {
        error: this.errorMessage(error),
        batchSize: facts.length,
      })
    }

    return this.writeBatchToFallbackAnalytics(facts)
  }

  private async writeBatchToFallbackAnalytics(
    facts: AnalyticsEntitlementMeterFact[]
  ): Promise<boolean> {
    if (!this.fallbackAnalytics) {
      this.logger.error("Fallback analytics dataset is not configured", {
        batchSize: facts.length,
      })
      return false
    }

    try {
      for (const fact of facts) {
        this.fallbackAnalytics.writeDataPoint({
          indexes: [fact.project_id, fact.customer_id, fact.meter_id],
          doubles: [fact.timestamp, fact.created_at, fact.delta, fact.value_after],
          blobs: [fact.id, fact.entitlement_id, JSON.stringify(fact)],
        })
      }

      return true
    } catch (error) {
      this.logger.error("Failed to write entitlement meter facts to fallback analytics", {
        error: this.errorMessage(error),
        batchSize: facts.length,
      })
      return false
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return String(error ?? "unknown error")
  }

  private getPeriodEndMs(): number {
    return Date.now() - 10 * 24 * 60 * 60 * 1000
  }

  private getOutboxCount(): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(meterFactsOutboxTable).get()

    return Number(row?.count ?? 0)
  }

  private normalizeLimit(limit: number | null | undefined): number | null {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return null
    }

    return limit
  }

  private makeMeterStateKey(meterId: string): string {
    return `meter-state:${meterId}`
  }
}
