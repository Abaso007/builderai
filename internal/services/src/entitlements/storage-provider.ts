import type { Result } from "@unprice/error"
import type { UnPriceEntitlementStorageError } from "./errors"
import type { EntitlementState, UsageRecord, VerificationRecord } from "./types"

/**
 * Simple storage provider interface for plug-and-play backends
 */
export interface EntitlementStorageProvider {
  readonly name: string

  get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>>

  set(params: { state: EntitlementState }): Promise<Result<void, UnPriceEntitlementStorageError>>

  delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Buffer usage record for batch sending
   * Useful for DO with alarms or Redis with pipelines
   */
  bufferUsageRecord?(record: UsageRecord): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Buffer verification record for batch sending
   */
  bufferVerification?(
    record: VerificationRecord
  ): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Flush buffered records to analytics/DB
   * Returns the records so caller can send to Tinybird
   * Called by alarms or periodic timers
   */
  flush?(): Promise<
    Result<
      {
        usage: UsageRecord[]
        verifications: VerificationRecord[]
      },
      UnPriceEntitlementStorageError
    >
  >
}
