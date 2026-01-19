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

export type OverageStrategy =
  | "none" // Strict: currentTokens >= cost
  | "last-call" // Allow if currentTokens > 0
  | "always" // Record & Penalize: Always allow (if cost is valid)

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
   * Strategy for handling usage that exceeds the remaining capacity.
   * - "none": Strict hard limit. cost must be <= remaining tokens.
   * - "last-call": Allow one final report as long as tokens were available (tokens > 0).
   * - "always": Always allow (soft limit/overage enabled).
   *
   * Default: "none"
   */
  overageStrategy?: OverageStrategy
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
    return Math.min(ceiling, tokens)
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
  verify(
    now: number,
    cost = 0
  ): {
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
        remaining: this.tokens,
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
        remaining: this.tokens,
        retryAfterMs: 0,
        overThreshold: false,
        message: "Unlimited feature",
      }
    }

    // 4. Verify capacity
    const currentTokens = this.tokens
    const strategy = this.config.overageStrategy ?? "none"

    let isAllowed = false

    if (strategy === "always") {
      isAllowed = true
    } else if (strategy === "last-call") {
      isAllowed = cost <= 0 || currentTokens > 0
    } else {
      // strategy === "none" (strict)
      isAllowed = currentTokens >= cost
    }

    if (!isAllowed) {
      return {
        allowed: false,
        remaining: this.tokens,
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
    // 0. Check if the feature is flat
    if (this.config.featureType === "flat") {
      return {
        allowed: false,
        remaining: this.tokens,
        retryAfterMs: 0,
        overThreshold: false,
        deniedReason: "FLAT_FEATURE_NOT_ALLOWED_REPORT_USAGE",
        message: "Flat feature not allowed to be reported",
      }
    }

    // 1. Sync Logic (Check if we jumped to a new mathematical period)
    this.sync(now)

    // 2. Check if the usage is valid
    const { isValid, message } = this.isValidUsage(cost)

    if (!isValid) {
      return {
        allowed: false,
        remaining: this.tokens,
        retryAfterMs: 0,
        overThreshold: false,
        deniedReason: "INVALID_USAGE",
        message,
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

    // 4. Check Balance
    const currentTokens = this.tokens
    const strategy = this.config.overageStrategy ?? "none"

    // 5. handle consumption
    let isAllowed = false

    if (cost <= 0) {
      isAllowed = true // Always allow corrections
    } else if (strategy === "always") {
      isAllowed = true
    } else if (strategy === "last-call") {
      isAllowed = currentTokens > 0
    } else {
      // strategy === "none" (strict)
      isAllowed = currentTokens >= cost
    }

    if (isAllowed) {
      // update the usage
      const newUsage = this.applyUsage(cost)

      // update the state
      this.usage = newUsage
      this.lastUpdated = now

      return {
        allowed: true,
        remaining: this.tokens, // Recalculate after usage update
        retryAfterMs: 0,
        overThreshold: this.isOverThreshold(),
      }
    }

    // 6. Denied (hard limit)
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
      return {
        isValid: true,
      }
    }

    // for negative usage that is not sum, sum_all
    // count and count_all are not affected by negative usage they are monotonic increasing
    if (cost < 0 && !["sum", "sum_all"].includes(this.config.aggregationMethod)) {
      return {
        isValid: false,
        message: "Negative usage is not allowed for this aggregation method",
      }
    }

    // and the current usage - the cost is not negative
    const newUsage = this.applyUsage(cost)

    if (Number(newUsage) < 0) {
      return {
        isValid: false,
        message: "Total usage would be negative",
      }
    }

    return {
      isValid: true,
    }
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
   * Applies the usage to the meter based on the aggregation method
   * @param amount - The amount to calculate the usage from
   * @returns The usage after the calculation
   */
  private applyUsage(amount: number) {
    const config = AGGREGATION_CONFIG[this.config.aggregationMethod]

    let newUsage = this.usage

    // Update usage as string to avoid precision issues
    if (config.behavior === "sum") {
      newUsage = (Number(this.usage) + amount).toString()
    } else if (config.behavior === "max") {
      newUsage = Math.max(Number(this.usage), amount).toString()
    } else if (config.behavior === "last") {
      newUsage = amount.toString()
    }

    return newUsage
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
    if (this.isUnlimited() || this.config.threshold === undefined) {
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
    return {
      lastUpdated: this.lastUpdated,
      usage: this.usage,
      lastCycleStart: this.lastCycleStart,
      lastReconciledId: this.lastReconciledId,
      snapshotUsage: this.snapshotUsage,
    }
  }
}
