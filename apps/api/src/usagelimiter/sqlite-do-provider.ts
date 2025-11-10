import type { AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { EntitlementState } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import {
  type UnPriceEntitlementStorage,
  UnPriceEntitlementStorageError,
} from "@unprice/services/entitlements"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import { schema } from "~/db/types"

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

  constructor(
    private readonly db: DrizzleSqliteDODatabase<typeof schema>,
    private storage: DurableObjectStorage,
    private readonly logger: Logger
  ) {}

  async getAll(): Promise<Result<EntitlementState[], UnPriceEntitlementStorageError>> {
    try {
      const states = await this.storage.list()
      return Ok(Object.values(states).map((state) => state as EntitlementState))
    } catch (error) {
      this.logger.error("DO getAll failed", {
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

  async get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>> {
    try {
      const key = this.makeKey(params)
      const value = await this.storage.get<EntitlementState>(key)
      return Ok(value ?? null)
    } catch (error) {
      this.logger.error("DO get failed", {
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

  async set(params: { state: EntitlementState }): Promise<
    Result<void, UnPriceEntitlementStorageError>
  > {
    try {
      const key = this.makeKey({
        customerId: params.state.customerId,
        projectId: params.state.projectId,
        featureSlug: params.state.featureSlug,
      })
      await this.storage.put(key, params.state)

      return Ok(undefined)
    } catch (error) {
      this.logger.error("DO set failed", {
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

  async delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      const key = this.makeKey(params)
      await this.storage.delete(key)

      return Ok(undefined)
    } catch (error) {
      this.logger.error("DO delete failed", {
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
      this.logger.error("Failed to insert usage record", {
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
      this.logger.error("Failed to insert verification", {
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
      this.logger.error("Failed to get verifications", {
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
      this.logger.error("Failed to get usage records", {
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
      await this.db.delete(schema.usageRecords)
      return Ok(undefined)
    } catch (error) {
      this.logger.error("Failed to delete all usage records", {
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
      await this.db.delete(schema.verifications)
      return Ok(undefined)
    } catch (error) {
      this.logger.error("Failed to delete all verifications", {
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
