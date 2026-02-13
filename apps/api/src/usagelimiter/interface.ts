import type {
  MinimalEntitlement,
  ReportUsageRequest,
  ReportUsageResult,
  SubscriptionStatus,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { CurrentUsage } from "@unprice/db/validators"
import type { BaseError, Result } from "@unprice/error"
import type { CacheNamespaces } from "@unprice/services/cache"
import { z } from "zod"

export const getEntitlementsRequestSchema = z.object({
  customerId: z.string(),
  projectId: z.string(),
  now: z.number(),
})
export type GetEntitlementsRequest = z.infer<typeof getEntitlementsRequestSchema>

export const getUsageRequestSchema = z.object({
  customerId: z.string(),
  projectId: z.string(),
  now: z.number(),
})

export type GetUsageRequest = z.infer<typeof getUsageRequestSchema>

export const bufferMetricsResponseSchema = z.object({
  usageCount: z.number(),
  verificationCount: z.number(),
  totalUsage: z.number(),
  allowedCount: z.number(),
  deniedCount: z.number(),
  bucketSizeSeconds: z.number(),
  featureStats: z.array(
    z.object({
      featureSlug: z.string(),
      usageCount: z.number(),
      verificationCount: z.number(),
      totalUsage: z.number(),
    })
  ),
  usageSeries: z.array(
    z.object({
      bucketStart: z.number(),
      usageCount: z.number(),
      totalUsage: z.number(),
    })
  ),
  verificationSeries: z.array(
    z.object({
      bucketStart: z.number(),
      verificationCount: z.number(),
      allowedCount: z.number(),
      deniedCount: z.number(),
    })
  ),
  oldestTimestamp: z.number().nullable(),
  newestTimestamp: z.number().nullable(),
})

export const bufferMetricsWindowSecondsSchema = z.union([
  z.literal(300),
  z.literal(3600),
  z.literal(86400),
  z.literal(604800),
])

export type BufferMetricsResponse = z.infer<typeof bufferMetricsResponseSchema>

export interface UsageLimiter {
  /**
   * Verify a request
   * This is used to verify a request and return the verification result
   */
  verify(data: VerifyRequest): Promise<Result<VerificationResult, BaseError>>
  /**
   * Report usage
   * This is used to report usage for a customer and project
   */
  reportUsage(data: ReportUsageRequest): Promise<Result<ReportUsageResult, BaseError>>
  /**
   * Get the active entitlements for a customer and project
   * This is used to get the active entitlements for a customer and project
   */
  getActiveEntitlements(
    data: GetEntitlementsRequest
  ): Promise<Result<MinimalEntitlement[], BaseError>>
  /**
   * Get the current usage for a customer and project
   * This is used to get the current usage for a customer and project
   */
  getCurrentUsage(data: GetUsageRequest): Promise<Result<CurrentUsage, BaseError>>
  /**
   * Reset the entitlements for a customer and project
   * This is used to reset the entitlements for a customer and project
   */
  resetEntitlements(params: { customerId: string; projectId: string }): Promise<
    Result<void, BaseError>
  >
  /**
   * Get the access control list from the cache
   * This is used to get the ACL for a customer and project
   */
  getAccessControlList(data: {
    customerId: string
    projectId: string
    now: number
  }): Promise<{
    customerUsageLimitReached: boolean | null
    customerDisabled: boolean | null
    subscriptionStatus: SubscriptionStatus | null
  } | null>

  /**
   * Update the access control list in the cache
   * This is used to partially update the ACL when a specific flag changes
   */
  updateAccessControlList(data: {
    customerId: string
    projectId: string
    updates: Partial<NonNullable<CacheNamespaces["accessControlList"]>>
  }): Promise<void>

  /**
   * Get real-time buffer metrics from the Durable Object
   * Returns unflushed usage/verification records for real-time dashboards
   */
  getBufferMetrics(data: {
    customerId: string
    projectId: string
    windowSeconds?: z.infer<typeof bufferMetricsWindowSecondsSchema>
  }): Promise<Result<BufferMetricsResponse, BaseError>>
}
