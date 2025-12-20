import type { Analytics, AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { Entitlement } from "@unprice/db/validators"
import type { MeterState } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import {
  type UnPriceEntitlementStorage,
  UnPriceEntitlementStorageError,
} from "@unprice/services/entitlements"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { schema } from "~/db/types"
import migrations from "../../drizzle/migrations"

/**
 * SQLite Storage Provider for Durable Objects
 * Uses Drizzle ORM with DO's internal SQLite database
 *
 * Tables needed in your schema:
 * - entitlementStates: Cache entitlement snapshots
 * - usageRecordsBuffer: Buffer usage for Tinybird
 * - verificationsBuffer: Buffer verifications for Tinybird
 */
export class SqliteDOStorageProvider implements UnPriceEntitlementStorage {
  readonly name = "sqlite-do"
  private db: DrizzleSqliteDODatabase<typeof schema>
  private storage: DurableObjectStorage
  private state: DurableObjectState
  private analytics: Analytics
  private logger: Logger
  private memoizedStates: Map<string, Entitlement & MeterState> = new Map()
  // if the storage provider is initialized
  private initialized = false

  /**
   * Constructor
   */
  constructor(args: {
    storage: DurableObjectStorage
    state: DurableObjectState
    analytics: Analytics
    logger: Logger
  }) {
    this.storage = args.storage
    this.state = args.state
    this.analytics = args.analytics
    this.logger = args.logger
    this.db = drizzle(args.storage, { schema, logger: false })
  }

  /**
   * Initialize the storage provider
   */
  async initialize(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        // first migrate the database
        await this._migrate()

        // then set the initialized flag
        this.initialized = true

        // then memoize the states
        const { err } = await this.getAll()

        if (err) {
          return Err(err)
        }

        // return ok
        return Ok(undefined)
      } catch (error) {
        // set the initialized flag to false
        this.initialized = false

        // clear the memoized states
        this.memoizedStates.clear()

        this.logger.error(`SQLite DO ${this.state.id.toString()} initialize failed`, {
          error: error instanceof Error ? error.message : "unknown",
        })

        return Err(
          new UnPriceEntitlementStorageError({
            message: `Initialize failed: ${error instanceof Error ? error.message : "unknown"}`,
          })
        )
      }
    })
  }

  async _migrate() {
    try {
      await migrate(this.db, migrations)
    } catch (error) {
      // Log the error
      this.logger.error(`SQLite DO ${this.state.id.toString()} migrate failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
    }
  }

  private isInitialized(): Result<void, UnPriceEntitlementStorageError> {
    if (this.initialized) {
      return Ok(undefined)
    }

    throw new UnPriceEntitlementStorageError({ message: "Storage provider not initialized" })
  }

  /**
   * Delete all states from the storage
   */
  async deleteAll(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // delete all the states from the storage
      await this.storage.deleteAll()

      // clear the memoized states
      this.memoizedStates.clear()

      // migrate the database again
      await this._migrate()
      return Ok(undefined)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Delete all failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  /**
   * Get all entitlement states from DO
   */
  async getAll(): Promise<Result<(Entitlement & MeterState)[], UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // get the states from the storage
      const states = await this.storage.list<Entitlement & MeterState>()

      // clear the memoized states
      this.memoizedStates.clear()

      // memoize the new states
      states.forEach((value, key) => {
        // skip config key
        if (key.includes("config")) {
          return
        }

        if (value) {
          this.memoizedStates.set(key, value)
        }
      })

      // return the states
      return Ok(Array.from(this.memoizedStates.values()))
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} getAll failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Get all failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  /**
   * Get entitlement state from DO
   */
  async get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<(Entitlement & MeterState) | null, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      const key = this.makeKey(params)

      // check if the state is memoized
      const memoizedState = this.memoizedStates.get(key)

      // if the state is memoized, return it
      if (memoizedState) {
        return Ok(memoizedState)
      }

      // get the state from the storage
      const value = await this.storage.get<Entitlement & MeterState>(key)

      // memoize the state
      if (value) {
        this.memoizedStates.set(key, value)
      }

      // return the state
      return Ok(value ?? null)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} get failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Get failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  /**
   * Set entitlement state in DO
   */
  async set(params: { state: Entitlement & MeterState }): Promise<
    Result<void, UnPriceEntitlementStorageError>
  > {
    try {
      this.isInitialized()

      const key = this.makeKey({
        customerId: params.state.customerId,
        projectId: params.state.projectId,
        featureSlug: params.state.featureSlug,
      })

      // put the state in the storage
      await this.storage.put(key, params.state)

      // memoize the state
      this.memoizedStates.set(key, params.state)

      // return ok
      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} set failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Set failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  /**
   * Delete entitlement state from DO
   */
  async delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // make the key
      const key = this.makeKey(params)

      // delete the state from the storage
      await this.storage.delete(key)

      // delete the state from the memoized states
      this.memoizedStates.delete(key)

      // return ok
      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} delete failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Delete failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  /**
   * Insert usage record in SQLite
   */
  async insertUsageRecord(
    record: AnalyticsUsage
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // insert the usage record into the database
      await this.db
        .insert(schema.usageRecords)
        .values({
          id: record.id,
          customerId: record.customerId,
          featureSlug: record.featureSlug,
          usage: record.usage.toString(),
          timestamp: record.timestamp,
          createdAt: record.createdAt,
          metadata: record.metadata ? JSON.stringify(record.metadata) : null,
          deleted: record.deleted ? 1 : 0,
          idempotenceKey: record.idempotenceKey,
          requestId: record.requestId,
          projectId: record.projectId,
        }) // on conflict do nothing because we don't want to insert duplicates
        .onConflictDoNothing()

      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} insert usage record failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Insert usage record failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  /**
   * Buffer verification in SQLite
   */
  async insertVerification(
    record: AnalyticsVerification
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // insert the verification into the database
      await this.db.insert(schema.verifications).values({
        customerId: record.customerId,
        featureSlug: record.featureSlug,
        projectId: record.projectId,
        timestamp: record.timestamp,
        createdAt: record.createdAt,
        requestId: record.requestId,
        deniedReason: record.deniedReason,
        latency: record.latency ? record.latency.toString() : "0",
        allowed: record.allowed,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
      })

      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} insert verification failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Insert verification failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  /**
   * Get the last usage flushed id from SQLite
   * Get the min ID still in buffer, everything before that has been flushed
   */
  public async getLastUsageFlushedId(
    featureSlug: string
  ): Promise<Result<string | null, UnPriceEntitlementStorageError>> {
    // Query the min ID still in buffer for this feature
    const records = await this.db
      .select({
        id: schema.usageRecords.id,
      })
      .from(schema.usageRecords)
      .where(
        and(eq(schema.usageRecords.featureSlug, featureSlug), eq(schema.usageRecords.deleted, 0))
      )
      .orderBy(asc(schema.usageRecords.id)) // ULID sort = oldest first
      .limit(1)

    if (records.length === 0) {
      return Ok(null)
    }

    return Ok(records[0]!.id)
  }

  /**
   * Get unflushed usage from SQLite buffer
   *
   * Returns aggregated values for records still in the buffer
   * (not yet flushed to Tinybird).
   */
  public async getUnflushedUsage(
    featureSlug: string
  ): Promise<
    Result<
      { sum: number; max: number; last: number | null; count: number },
      UnPriceEntitlementStorageError
    >
  > {
    // Query all unflushed records for this feature
    const records = await this.db
      .select({
        usage: schema.usageRecords.usage,
        id: schema.usageRecords.id,
      })
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.featureSlug, featureSlug))
      .orderBy(schema.usageRecords.id) // ULID sort = chronological sort

    if (records.length === 0) {
      return Ok({ sum: 0, max: 0, last: null, count: 0 })
    }

    return Ok({
      sum: records.reduce((acc, r) => acc + (r.usage ? Number(r.usage) : 0), 0),
      max: Math.max(...records.map((r) => (r.usage ? Number(r.usage) : 0))),
      last: records[records.length - 1]!.usage ? Number(records[records.length - 1]!.usage) : null, // Last by ULID = most recent
      count: records.length,
    })
  }

  private async sendVerificationsToTinybird(): Promise<{
    count: number
    lastId: string | null
  }> {
    // Process events in batches to avoid memory issues
    const BATCH_SIZE = 1000

    // Get a batch of events
    const verificationEvents = await this.db
      .select()
      .from(schema.verifications)
      .limit(BATCH_SIZE)
      .orderBy(schema.verifications.id)

    if (verificationEvents.length === 0) return { count: 0, lastId: null }

    const firstId = verificationEvents[0]?.id
    const lastId = verificationEvents[verificationEvents.length - 1]?.id

    try {
      // transform the verifications to the format expected by the analytics
      const transformedEvents = verificationEvents.map((verification) => ({
        ...verification,
        metadata: verification.metadata ? JSON.parse(verification.metadata) : null,
        latency: verification.latency ? Number(verification.latency) : 0,
        deniedReason: verification.deniedReason ?? undefined,
      }))

      await this.analytics
        .ingestFeaturesVerification(transformedEvents)
        .catch((e) => {
          this.logger.error(`Failed in ingestFeaturesVerification from do ${e.message}`, {
            error: JSON.stringify(e),
            customerId: transformedEvents[0]?.customerId,
            projectId: transformedEvents[0]?.projectId,
          })
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
              .delete(schema.verifications)
              .where(sql`id >= ${firstId} AND id <= ${lastId}`)
              .returning({ id: schema.verifications.id })

            const deleted = deletedResult.length

            this.logger.debug(
              `deleted ${deleted} verifications from do ${this.state.id.toString()} (range: ${firstId}-${lastId})`,
              {
                rows: total,
                deleted,
                expectedCount: verificationEvents.length,
              }
            )
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
        `Failed to send verifications to Tinybird from do ${this.state.id.toString()} ${error instanceof Error ? error.message : "unknown error"}`,
        {
          error: error instanceof Error ? JSON.stringify(error) : "unknown error",
          customerId: verificationEvents[0]?.customerId,
          projectId: verificationEvents[0]?.projectId,
        }
      )
    }

    // Update the last processed ID
    return { count: verificationEvents.length, lastId: lastId ? lastId.toString() : null }
  }

  private async sendUsageToTinybird(): Promise<{
    count: number
    lastId: string | null
  }> {
    const BATCH_SIZE = 1000

    // Get a batch of events
    // if featureSlug is provided, filter by featureSlug
    const events = await this.db
      .select()
      .from(schema.usageRecords)
      .limit(BATCH_SIZE)
      .orderBy(desc(schema.usageRecords.id))

    if (events.length === 0) return { count: 0, lastId: null }

    const firstId = events[0]?.id
    const lastId = events[events.length - 1]?.id

    // Create a Map to deduplicate events based on their unique identifiers
    const uniqueEvents = new Map()
    for (const event of events) {
      if (!uniqueEvents.has(event.idempotenceKey)) {
        uniqueEvents.set(event.idempotenceKey, {
          ...event,
          metadata: event.metadata ? JSON.parse(event.metadata) : {},
        })
      }
    }

    const deduplicatedEvents = Array.from(uniqueEvents.values())

    if (deduplicatedEvents.length > 0) {
      try {
        await this.analytics
          .ingestFeaturesUsage(deduplicatedEvents)
          .catch((e) => {
            this.logger.error(
              `Failed to send ${deduplicatedEvents.length} events to Tinybird from do ${this.state.id.toString()}:`,
              {
                error: e.message,
                customerId: deduplicatedEvents[0]?.customerId,
                projectId: deduplicatedEvents[0]?.projectId,
              }
            )
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
                .delete(schema.usageRecords)
                .where(sql`id >= ${firstId} AND id <= ${lastId}`)
                .returning({ id: schema.usageRecords.id })

              const deleted = deletedResult.length

              this.logger.debug(
                `deleted ${deleted} usage records from do ${this.state.id.toString()} (range: ${firstId}-${lastId})`,
                {
                  count: events.length,
                  deleted,
                }
              )
            } else {
              this.logger.debug(
                "the total of usage records sent to tinybird are not the same as the total of usage records in the db",
                {
                  total,
                  expected: events.length,
                  customerId: deduplicatedEvents[0]?.customerId,
                  projectId: deduplicatedEvents[0]?.projectId,
                }
              )
            }
          })
      } catch (error) {
        this.logger.error(
          `Failed to send events to Tinybird from do ${this.state.id.toString()}:`,
          {
            error: error instanceof Error ? error.message : "unknown error",
            customerId: deduplicatedEvents[0]?.customerId,
            projectId: deduplicatedEvents[0]?.projectId,
          }
        )
      }
    }

    // Update the last processed ID for the next batch
    return { count: events.length, lastId: lastId ?? null }
  }

  /**
   * Flush usage records and verifications
   * flushing on interval, if failed, retry later
   */
  async flush(): Promise<
    Result<
      {
        usage: { count: number; lastId: string | null }
        verification: { count: number; lastId: string | null }
      },
      UnPriceEntitlementStorageError
    >
  > {
    try {
      this.isInitialized()

      // delete usage records and verifications in parallel (fire and forget)
      const [usage, verification] = await Promise.all([
        this.sendUsageToTinybird(),
        this.sendVerificationsToTinybird(),
      ])

      return Ok({
        usage,
        verification,
      })
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} flush failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Flush failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  public makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `${params.projectId}:${params.customerId}:${params.featureSlug}`
  }
}
