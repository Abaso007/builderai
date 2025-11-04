import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { UnPriceEntitlementStorageError } from "@unprice/services/entitlements/errors"
import type { EntitlementStorageProvider } from "@unprice/services/entitlements/storage-provider"
import type {
  EntitlementState,
  UsageRecord,
  VerificationRecord,
} from "@unprice/services/entitlements/types"

/**
 * Durable Object Storage Provider with Buffering
 *
 * Buffers usage and verification records in DO storage,
 * then flushes them in batches (e.g., via alarms)
 */
export class DurableObjectStorageProvider implements EntitlementStorageProvider {
  readonly name = "durable-object"

  constructor(
    private readonly storage: DurableObject,
    private readonly logger: Logger
  ) {}

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
   * Buffer usage record for batch sending
   * Stores in DO storage, will be flushed by alarm
   */
  async bufferUsageRecord(
    record: UsageRecord
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      // Get current buffer
      const bufferKey = "buffer:usage"
      const buffer = (await this.storage.get<UsageRecord[]>(bufferKey)) ?? []

      // Add new record
      buffer.push(record)

      // Save back
      await this.storage.put(bufferKey, buffer)

      this.logger.debug("Buffered usage record", {
        bufferSize: buffer.length,
        grantId: record.grantId,
      })

      return Ok(undefined)
    } catch (error) {
      this.logger.error("Failed to buffer usage", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Buffer failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Buffer verification record for batch sending
   */
  async bufferVerification(
    record: VerificationRecord
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      // Get current buffer
      const bufferKey = "buffer:verifications"
      const buffer = (await this.storage.get<VerificationRecord[]>(bufferKey)) ?? []

      // Add new record
      buffer.push(record)

      // Save back
      await this.storage.put(bufferKey, buffer)

      this.logger.debug("Buffered verification", {
        bufferSize: buffer.length,
        success: record.success,
      })

      return Ok(undefined)
    } catch (error) {
      this.logger.error("Failed to buffer verification", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Buffer failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Flush buffered records
   *
   * Returns the records to be sent to analytics/DB
   * Clears the buffers after reading
   *
   * This should be called by your DO's onAlarm() method
   */
  async flush(): Promise<
    Result<
      {
        usage: UsageRecord[]
        verifications: VerificationRecord[]
      },
      UnPriceEntitlementStorageError
    >
  > {
    try {
      // Get buffers
      const usageKey = "buffer:usage"
      const verificationKey = "buffer:verifications"

      const usage = (await this.storage.get<UsageRecord[]>(usageKey)) ?? []
      const verifications = (await this.storage.get<VerificationRecord[]>(verificationKey)) ?? []

      // Clear buffers
      await this.storage.delete([usageKey, verificationKey])

      this.logger.info("Flushed buffers", {
        usageCount: usage.length,
        verificationCount: verifications.length,
      })

      return Ok({ usage, verifications })
    } catch (error) {
      this.logger.error("Failed to flush buffers", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Flush failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  /**
   * Get buffer sizes (for monitoring)
   */
  async getBufferSizes(): Promise<{ usage: number; verifications: number }> {
    const usage = (await this.storage.get<UsageRecord[]>("buffer:usage")) ?? []
    const verifications =
      (await this.storage.get<VerificationRecord[]>("buffer:verifications")) ?? []

    return {
      usage: usage.length,
      verifications: verifications.length,
    }
  }

  private makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `entitlement:${params.projectId}:${params.customerId}:${params.featureSlug}`
  }
}
