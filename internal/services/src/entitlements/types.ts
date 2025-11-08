/**
 * Simplified types for entitlement consumption
 *
 * Key assumptions:
 * - Entitlements are snapshots (no runtime recomputation)
 * - Tinybird handles grant consumption tracking
 * - Cache (DO/Redis) for low latency, PostgreSQL synced periodically
 */

import type { DenyReason } from "../customers"

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
 * Usage record for buffering
 */
export type UsageRecord = {
  id: number
  entitlementId: string
  idempotenceKey: string
  requestId: string
  featureSlug: string
  customerId: string
  projectId: string
  featurePlanVersionId: string
  subscriptionItemId: string | null
  subscriptionPhaseId: string | null
  subscriptionId: string | null
  grantId: string
  timestamp: number
  createdAt: number
  usage: string | null
  metadata: string | null
  deleted: number
}

/**
 * Verification record for buffering
 */
export type VerificationRecord = {
  id: number
  entitlementId: string
  requestId: string
  featureSlug: string
  customerId: string
  projectId: string
  timestamp: number
  createdAt: number
  metadata: string | null
  deniedReason: string | null
  latency: string | null
  success: number
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
  deniedReason?: DenyReason
}
