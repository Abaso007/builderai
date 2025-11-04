/**
 * Simplified types for entitlement consumption
 *
 * Key assumptions:
 * - Entitlements are snapshots (no runtime recomputation)
 * - Tinybird handles grant consumption tracking
 * - Cache (DO/Redis) for low latency, PostgreSQL synced periodically
 */

/**
 * Grant within an entitlement snapshot
 */
export interface Grant {
  id: string
  priority: number // 100=manual, 90=promo, 80=trial, 10=subscription
  type: string
  limit: number | null // null = unlimited
  consumed: number // tracked in cache
}

/**
 * Entitlement state (cached in DO/Redis)
 */
export interface EntitlementState {
  id: string
  customerId: string
  projectId: string
  featureSlug: string
  featureType: string

  // Current usage (mutable in cache)
  currentUsage: number
  limit: number | null

  // Grants sorted by priority (from snapshot)
  grants: Grant[]

  // For sync with PostgreSQL
  version: number
  lastSyncAt: number

  // For cache invalidation
  nextRevalidateAt: number // When to check DB for new version
  computedAt: number // When snapshot was created in DB
}

/**
 * Usage record for buffering
 */
export interface UsageRecord {
  customerId: string
  projectId: string
  featureSlug: string
  usage: number
  timestamp: number
  grantId: string
  grantType: string
  grantPriority: number
  metadata?: Record<string, unknown>
}

/**
 * Verification record for buffering
 */
export interface VerificationRecord {
  customerId: string
  projectId: string
  featureSlug: string
  timestamp: number
  success: boolean
  deniedReason?: string
  metadata?: Record<string, unknown>
}

/**
 * Result of consumption
 */
export interface ConsumptionResult {
  success: boolean
  message: string
  usage: number
  limit: number | null

  // For Tinybird/analytics (simple billing attribution)
  consumedFrom: Array<{
    grantId: string
    amount: number
    priority: number
    type: string
  }>
}

/**
 * Verification result (can check)
 */
export interface VerificationResult {
  allowed: boolean
  message: string
  usage: number
  limit: number | null
}
