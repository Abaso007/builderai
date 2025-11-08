import type { EntitlementState } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import type { UnPriceEntitlementStorageError } from "./errors"
import type { UsageRecord, VerificationRecord } from "./types"

/**
 * Simple storage provider interface for plug-and-play backends
 */
export interface UnPriceEntitlementStorage {
  readonly name: string

  /**
   * Get an entitlement state
   */
  get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>>

  /**
   * Get all entitlement states
   */
  getAll(): Promise<Result<EntitlementState[], UnPriceEntitlementStorageError>>

  /**
   * Set an entitlement state
   */
  set(params: { state: EntitlementState }): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Delete an entitlement state
   */
  delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Insert usage record for batch sending
   * Useful for DO with alarms or Redis with pipelines
   */
  insertUsageRecord(record: UsageRecord): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Insert verification record for batch sending
   */
  insertVerification(
    record: Omit<VerificationRecord, "id">
  ): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Delete all verifications
   */
  deleteAllVerifications(): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Delete all usage records
   */
  deleteAllUsageRecords(): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Get all verifications
   */
  getVerifications(): Promise<Result<VerificationRecord[], UnPriceEntitlementStorageError>>

  /**
   * Get all usage records
   */
  getUsageRecords(): Promise<Result<UsageRecord[], UnPriceEntitlementStorageError>>
}
