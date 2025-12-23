// ---------------------------------------------------------
// 1. CONFIGURATION & STATE

import { AGGREGATION_CONFIG } from "@unprice/db/utils"
import {
  type AggregationMethod,
  type FeatureType,
  type MeterState,
  type ResetConfig,
  calculateCycleWindow,
} from "@unprice/db/validators"
import type { DenyReason } from "../customers"

// ---------------------------------------------------------
export interface MeterConfig {
  /**
   * The feature type.
   */
  featureType: FeatureType

  /**
   * The Maximum limit per period (e.g. 100 messages).
   * -1 or Infinity for Unlimited.
   */
  capacity: number

  /**
   * The aggregation method for the meter.
   */
  aggregationMethod: AggregationMethod

  /**
   * The Anchor Timestamp.
   * All reset cycles are calculated relative to this date.
   * Example: The subscription creation date, or the billing cycle anchor.
   */
  startDate: number

  /**
   * Optional: When does this bucket expire?
   * If provided, usage is blocked after this date.
   */
  endDate: number | null

  /**
   * The reset config for the bucket.
   */
  resetConfig: ResetConfig | null

  /**
   * Max burst as a percentage of capacity.
   * 1.0 = 100% (No burst).
   * Default: 1.0
   */
  maxBurstPercentage?: number

  /**
   * Initial tokens available on start.
   * Default: capacity.
   */
  initialTokens?: number

  /**
   * Threshold as a percentage of capacity (0.0 to 1.0).
   * When usage exceeds this threshold, the overThreshold flag will be set.
   * Example: 0.9 = 90% threshold.
   * Default: undefined (no threshold).
   */
  threshold?: number

  /**
   * Whether to allow usage beyond the capacity limit.
   * When true, usage can exceed the limit (soft limit).
   * When false, usage is blocked when limit is reached (hard limit).
   * Default: false.
   */
  allowOverage?: boolean
}

// ---------------------------------------------------------
// 2. THE DETERMINISTIC USAGE BUCKET
// ---------------------------------------------------------
export class UsageMeter {
  private lastUpdated: number
  private usage: string // Store as string to avoid JS precision issues
  private lastCycleStart?: number // Track the last cycle boundary we processed
  private lastReconciledId: string // Track the last reconciled id
  private snapshotUsage: string // Track the snapshot usage

  private readonly config: MeterConfig

  constructor(config: MeterConfig, initialState: MeterState) {
    this.config = config
    this.lastUpdated = initialState.lastUpdated
    this.usage = initialState.usage
    this.lastCycleStart = initialState.lastCycleStart
    this.lastReconciledId = initialState.lastReconciledId
    this.snapshotUsage = initialState.snapshotUsage
  }

  /**
   * Get usage as number for calculations.
   */
  private get usageNumber(): number {
    return Number(this.usage)
  }

  /**
   * Calculate current tokens based on capacity and period usage.
   */
  private get tokens(): number {
    if (this.isUnlimited()) {
      return Number.POSITIVE_INFINITY
    }

    const tokens = this.config.capacity - this.usageNumber
    const ceiling = this.config.capacity * (this.config.maxBurstPercentage ?? 1.0)
    // Cap at ceiling (for burst scenarios)
    return Math.min(ceiling, Math.max(0, tokens))
  }

  private isUnlimited(): boolean {
    // flat features are always unlimited
    return (
      this.config.capacity === -1 ||
      this.config.capacity === Number.POSITIVE_INFINITY ||
      this.config.featureType === "flat"
    )
  }

  /**
   * verify
   */
  verify(now: number): {
    allowed: boolean
    remaining: number
    retryAfterMs: number
    overThreshold: boolean
    deniedReason?: DenyReason
    message?: string
  } {
    // 1. Sync the meter to check if there is a new cycle boundary
    this.sync(now)

    // 2. Check if the entitlement is expired
    if (this.isExpired(now)) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: -1,
        overThreshold: false,
        deniedReason: "ENTITLEMENT_EXPIRED",
        message: "Entitlement expired",
      }
    }

    // 3. Check if the feature is unlimited
    if (this.isUnlimited()) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
        overThreshold: false,
      }
    }

    // 4. Verify capacity
    const allowOverage = this.config.allowOverage ?? false
    const currentTokens = this.tokens

    if (currentTokens < 0 && !allowOverage) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: 0,
        overThreshold: false,
        deniedReason: "LIMIT_EXCEEDED",
        message: "Limit exceeded",
      }
    }

    // 5. Return the verification result
    return {
      allowed: true,
      remaining: currentTokens,
      retryAfterMs: 0,
      overThreshold: this.isOverThreshold(),
    }
  }

  /**
   * Main entry point to consume quota.
   */
  consume(
    cost: number,
    now: number
  ): {
    allowed: boolean
    remaining: number
    retryAfterMs: number
    overThreshold: boolean
    deniedReason?: DenyReason
    message?: string
  } {
    // 1. Sync Logic (Check if we jumped to a new mathematical period)
    this.sync(now)

    // 2. Check if the usage is valid
    if (!this.isValidUsage(cost)) {
      return {
        allowed: false,
        remaining: this.tokens,
        retryAfterMs: 0,
        overThreshold: false,
        deniedReason: "INVALID_USAGE",
        message: `Invalid usage for feature type: ${this.config.featureType} and aggregation method: ${this.config.aggregationMethod}`,
      }
    }

    // 3. Check if the entitlement is expired
    if (this.isExpired(now)) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: -1,
        overThreshold: false,
        deniedReason: "ENTITLEMENT_EXPIRED",
        message: "Entitlement expired",
      }
    }

    // 4. Check if the feature is unlimited
    if (this.isUnlimited()) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
        overThreshold: false,
      }
    }

    // 6. Check Balance
    const currentTokens = this.tokens
    const allowOverage = this.config.allowOverage ?? false

    // 7. handle consumption
    if (currentTokens >= cost || allowOverage) {
      // update the usage
      this.updateUsage(cost, now)

      return {
        allowed: true,
        remaining: this.tokens, // Recalculate after usage update
        retryAfterMs: 0,
        overThreshold: this.isOverThreshold(),
      }
    }

    // 8. Denied (hard limit)
    const overThreshold = this.isOverThreshold()
    return {
      allowed: false,
      remaining: this.tokens,
      retryAfterMs: this.getTimeUntilNextPeriod(now),
      overThreshold,
      deniedReason: "LIMIT_EXCEEDED",
      message: "Limit exceeded",
    }
  }

  private isValidUsage(cost: number) {
    // check if flat feature
    if (this.config.featureType === "flat") {
      return false
    }

    // for negative usage that is not sum, sum_all
    // count and count_all are not affected by negative usage they are monotonic increasing
    if (cost < 0 && !["sum", "sum_all"].includes(this.config.aggregationMethod)) {
      return false
    }

    return true
  }

  private isExpired(now: number): boolean {
    // 0. Check Expiration (End Date)
    if (this.config.endDate && now > this.config.endDate) {
      return true
    }

    if (this.config.startDate > now) {
      return true
    }

    return false
  }

  /**
   * Updates the global counter based on the aggregation method
   * @param params - The parameters for the calculation
   * @param params.aggregationMethod - The aggregation method to use
   * @param params.amount - The amount to calculate the usage from
   * @param params.usage - The usage to calculate the usage from
   * @returns The usage after the calculation
   */
  private updateUsage(amount: number, now: number) {
    const config = AGGREGATION_CONFIG[this.config.aggregationMethod]

    // Update usage as string to avoid precision issues
    if (config.behavior === "sum") {
      this.usage = (Number(this.usage) + amount).toString()
    } else if (config.behavior === "max") {
      this.usage = Math.max(Number(this.usage), amount).toString()
    } else if (config.behavior === "last") {
      this.usage = amount.toString()
    }

    this.lastUpdated = now
  }

  /**
   * Returns usages stats without modifying state (readonly-ish).
   * Useful for showing "You have used X of Y today" in UI.
   */
  public getUsage(now = Date.now()) {
    // We must project what the state WOULD be at 'now' to give accurate info
    // without actually mutating the bucket if we don't want to.
    // However, lazily syncing is usually fine.
    this.sync(now)

    return {
      remaining: this.tokens,
      usage: this.usageNumber,
      limit: this.config.capacity,
      pctUsed: (this.usageNumber / this.config.capacity) * 100,
      overThreshold: this.isOverThreshold(),
    }
  }

  /**
   * Checks if current usage exceeds the configured threshold.
   */
  private isOverThreshold(): boolean {
    if (this.isUnlimited() || !this.config.threshold) {
      return false
    }

    const thresholdValue = this.config.capacity * this.config.threshold
    return this.usageNumber > thresholdValue
  }

  /**
   * Core Logic: Determines if we have crossed a period boundary based on math.
   */
  private sync(now: number): void {
    if (now < this.config.startDate) return // Not started yet

    if (!this.config.resetConfig) {
      return // no reset config, so no normalization needed
    }

    // Calculate which reset cycle slice "now" falls into
    const resetCycleForNow = calculateCycleWindow({
      now: now,
      trialEndsAt: null,
      effectiveStartDate: this.config.startDate,
      effectiveEndDate: this.config.endDate,
      config: {
        name: this.config.resetConfig.name,
        interval: this.config.resetConfig.resetInterval,
        intervalCount: this.config.resetConfig.resetIntervalCount,
        anchor: this.config.resetConfig.resetAnchor,
        planType: this.config.resetConfig.planType,
      },
    })

    if (!resetCycleForNow) {
      return // no reset cycle for now, so no normalization needed
    }

    // Use lastCycleStart to detect boundary crossings
    // If we don't have lastCycleStart, initialize it to the current cycle start
    // This handles the first sync after creation/restore
    const lastCycleStart = this.lastCycleStart ?? resetCycleForNow.start

    // Check if we've crossed a boundary by comparing the last cycle we processed
    // with the current cycle we're in
    const resetBoundaryCrossed = lastCycleStart < resetCycleForNow.start

    // If we have jumped forward one or more periods
    if (resetBoundaryCrossed) {
      this.performReset()

      // Update the last cycle start to the current cycle start
      this.lastCycleStart = resetCycleForNow.start
    } else if (!this.lastCycleStart) {
      // First time syncing - initialize lastCycleStart
      this.lastCycleStart = resetCycleForNow.start
    }

    // Always keep lastUpdated fresh
    this.lastUpdated = now
  }

  private performReset(): void {
    const config = AGGREGATION_CONFIG[this.config.aggregationMethod]

    // Handle cross-boundary reset: move current cycle usage to accumulated and reset current cycle
    if (config.scope === "period") {
      // scope period means there is a cadence for the reset
      this.usage = "0"
    }
  }

  private getTimeUntilNextPeriod(now: number): number {
    if (!this.config.resetConfig) {
      return 0 // no reset config, so no normalization needed
    }

    const resetCycleForNow = calculateCycleWindow({
      now: now,
      trialEndsAt: null,
      effectiveStartDate: this.config.startDate,
      effectiveEndDate: this.config.endDate,
      config: {
        name: this.config.resetConfig.name,
        interval: this.config.resetConfig.resetInterval,
        intervalCount: this.config.resetConfig.resetIntervalCount,
        anchor: this.config.resetConfig.resetAnchor,
        planType: this.config.resetConfig.planType,
      },
    })

    if (!resetCycleForNow) {
      return 0 // no reset cycle for now, so no normalization needed
    }

    return resetCycleForNow.end - now
  }

  // -------------------------------------------------------
  // PERSISTENCE
  // -------------------------------------------------------
  toPersist(): MeterState {
    // Ensure state is up to date before saving
    this.sync(Date.now())
    return {
      lastUpdated: this.lastUpdated,
      usage: this.usage,
      lastCycleStart: this.lastCycleStart,
      lastReconciledId: this.lastReconciledId,
      snapshotUsage: this.snapshotUsage,
    }
  }
}
