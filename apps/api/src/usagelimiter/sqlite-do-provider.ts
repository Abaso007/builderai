import type { AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { EntitlementState } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import {
  type UnPriceEntitlementStorage,
  UnPriceEntitlementStorageError,
} from "@unprice/services/entitlements"
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
  private logger: Logger
  private memoizedStates: Map<string, EntitlementState> = new Map()
  // if the storage provider is initialized
  private initialized = false

  /**
   * Constructor
   */
  constructor(args: {
    storage: DurableObjectStorage
    state: DurableObjectState
    logger: Logger
  }) {
    this.storage = args.storage
    this.state = args.state
    this.logger = args.logger
    this.db = drizzle(args.storage, { logger: false })
  }

  /**
   * Initialize the storage provider
   */
  async initialize(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        // first migrate the database
        await this._migrate()

        // then memoize the states
        const { err } = await this.getAll()

        if (err) {
          return Err(err)
        }

        // then set the initialized flag
        this.initialized = true

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

        return Err(new UnPriceEntitlementStorageError({ message: "Initialize failed" }))
      }
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

      await this.storage.deleteAll()
      await this.state.blockConcurrencyWhile(async () => {
        this.memoizedStates.clear()
      })
      return Ok(undefined)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Delete all failed",
          context: { error: error instanceof Error ? error.message : "unknown" },
        })
      )
    }
  }

  /**
   * Get all entitlement states from DO
   */
  async getAll(): Promise<Result<EntitlementState[], UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // get the states from the storage
      const states = await this.storage.list<EntitlementState>()

      // memoize the states
      await this.state.blockConcurrencyWhile(async () => {
        // clear the memoized states
        this.memoizedStates.clear()

        // memoize the new states
        states.forEach((value, key) => {
          if (value) {
            this.memoizedStates.set(key, value)
          }
        })
      })

      // return the states
      return Ok(Array.from(this.memoizedStates.values()))
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} getAll failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Get all failed",
          context: { error: error instanceof Error ? error.message : "unknown" },
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
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>> {
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
      const value = await this.storage.get<EntitlementState>(key)

      // memoize the state
      if (value) {
        await this.state.blockConcurrencyWhile(async () => {
          this.memoizedStates.set(key, value)
        })
      }

      // return the state
      return Ok(value ?? null)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} get failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Get failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Set entitlement state in DO
   */
  async set(params: { state: EntitlementState }): Promise<
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
      await this.state.blockConcurrencyWhile(async () => {
        this.memoizedStates.set(key, params.state)
      })

      // return ok
      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} set failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Set failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
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
      await this.state.blockConcurrencyWhile(async () => {
        this.memoizedStates.delete(key)
      })

      // return ok
      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} delete failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Delete failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
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
      await this.db.insert(schema.usageRecords).values({
        entitlementId: record.entitlementId,
        customerId: record.customerId,
        featureSlug: record.featureSlug,
        usage: record.usage.toString(),
        featurePlanVersionId: record.featurePlanVersionId,
        subscriptionItemId: record.subscriptionItemId,
        subscriptionPhaseId: record.subscriptionPhaseId,
        subscriptionId: record.subscriptionId,
        grantId: record.grantId,
        timestamp: record.timestamp,
        createdAt: record.createdAt,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
        deleted: record.deleted ? 1 : 0,
        idempotenceKey: record.idempotenceKey,
        requestId: record.requestId,
        projectId: record.projectId,
      })

      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} insert usage record failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Insert usage record failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
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
        entitlementId: record.entitlementId,
        customerId: record.customerId,
        featureSlug: record.featureSlug,
        projectId: record.projectId,
        timestamp: record.timestamp,
        createdAt: record.createdAt,
        requestId: record.requestId,
        deniedReason: record.deniedReason,
        latency: record.latency ? record.latency.toString() : "0",
        success: record.allowed ? 1 : 0,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
      })

      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} insert verification failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Insert verification failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Get all verifications
   */
  async getAllVerifications(): Promise<
    Result<AnalyticsVerification[], UnPriceEntitlementStorageError>
  > {
    try {
      this.isInitialized()

      // get the verifications from the database
      const verifications = await this.db.query.verifications.findMany()
      return Ok(
        verifications.map((verification) => ({
          ...verification,
          allowed: verification.success === 1,
          metadata: verification.metadata ? JSON.parse(verification.metadata) : null,
          latency: verification.latency ? Number(verification.latency) : 0,
          createdAt: verification.createdAt,
          requestId: verification.requestId,
          entitlementId: verification.entitlementId,
          customerId: verification.customerId,
          featureSlug: verification.featureSlug,
          projectId: verification.projectId,
          timestamp: verification.timestamp,
          deniedReason: verification.deniedReason ?? undefined,
        }))
      )
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} get verifications failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })

      return Err(
        new UnPriceEntitlementStorageError({
          message: "Get verifications failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Get all usage records
   */
  async getAllUsageRecords(): Promise<Result<AnalyticsUsage[], UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // get the usage records from the database
      const usage = await this.db.query.usageRecords.findMany()
      return Ok(
        usage.map((usage) => ({
          ...usage,
          metadata: usage.metadata ? JSON.parse(usage.metadata) : null,
          usage: usage.usage ? Number(usage.usage) : 0,
          createdAt: usage.createdAt,
          requestId: usage.requestId,
          entitlementId: usage.entitlementId,
        }))
      )
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} get usage records failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Get usage records failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Delete all usage records
   */
  async deleteAllUsageRecords(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // delete the usage records from the database
      await this.db.delete(schema.usageRecords)
      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} delete all usage records failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Delete all usage records failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Delete all verifications
   */
  async deleteAllVerifications(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()

      // delete the verifications from the database
      await this.db.delete(schema.verifications)
      return Ok(undefined)
    } catch (error) {
      this.logger.error(`SQLite DO ${this.state.id.toString()} delete all verifications failed`, {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Delete all verifications failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  private makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `${params.projectId}:${params.customerId}:${params.featureSlug}`
  }
}
