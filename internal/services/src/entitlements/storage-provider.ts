import type { AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { EntitlementState } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import type { UnPriceEntitlementStorageError } from "./errors"

/**
 * Simple storage provider interface for plug-and-play backends
 */
export interface UnPriceEntitlementStorage {
  readonly name: string

  /**
   * Initialize the storage provider
   */
  initialize(): Promise<Result<void, UnPriceEntitlementStorageError>>

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
   * Delete all entitlement states
   */
  deleteAll(): Promise<Result<void, UnPriceEntitlementStorageError>>

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
  insertUsageRecord(record: AnalyticsUsage): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Insert verification record for batch sending
   */
  insertVerification(
    record: AnalyticsVerification
  ): Promise<Result<void, UnPriceEntitlementStorageError>>

  /**
   * Flush usage records and verifications
   * fire and forget
   */
  flush(): Promise<
    Result<
      {
        usage: {
          count: number
          lastId: string | null
        }
        verification: {
          count: number
          lastId: string | null
        }
      },
      UnPriceEntitlementStorageError
    >
  >

  /**
   * Make entitlement key
   */
  makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string
}
