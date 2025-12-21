// ---------------------------------------------------------
// 1. CONFIGURATION & STATE

import { AGGREGATION_CONFIG } from "@unprice/db/utils"
import {
  type AggregationMethod,
  type ResetConfig,
  calculateCycleWindow,
} from "@unprice/db/validators"
import type { DenyReason } from "../customers"

// ---------------------------------------------------------
export interface MeterConfig {
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
}

export interface MeterState {
  lastUpdated: number
  usage: string // Usage in the current specific cycle (string to avoid JS precision issues)
  lastCycleStart?: number // The start timestamp of the last cycle we processed (for boundary detection)
}

// ---------------------------------------------------------
// 2. THE DETERMINISTIC USAGE BUCKET
// ---------------------------------------------------------
export class UsageMeter {
  private lastUpdated: number
  private usage: string // Store as string to avoid JS precision issues
  private lastCycleStart?: number // Track the last cycle boundary we processed

  private readonly config: MeterConfig

  constructor(config: MeterConfig, initialState?: MeterState) {
    this.config = config

    if (this.isUnlimited()) {
      this.lastUpdated = Date.now()
      this.usage = "0"
      this.lastCycleStart = initialState?.lastCycleStart
    } else if (initialState) {
      this.lastUpdated = initialState.lastUpdated
      this.usage = initialState.usage
      this.lastCycleStart = initialState.lastCycleStart
    } else {
      this.lastUpdated = Date.now() // or config.startDate
      this.usage = "0"
      this.lastCycleStart = undefined // Will be set on first sync
    }
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

  isUnlimited(): boolean {
    return this.config.capacity === -1 || this.config.capacity === Number.POSITIVE_INFINITY
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
  } {
    // 0. Check Expiration (End Date)
    if (this.config.endDate && now > this.config.endDate) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: -1,
        overThreshold: false,
        deniedReason: "ENTITLEMENT_EXPIRED",
      } // -1 indicates "Expired/Never"
    }

    if (this.isUnlimited()) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
        overThreshold: false,
      }
    }

    // verify capacity
    if (this.tokens < 0) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: 0,
        overThreshold: false,
        deniedReason: "LIMIT_EXCEEDED",
      }
    }

    return {
      allowed: true,
      remaining: this.tokens,
      retryAfterMs: 0,
      overThreshold: this.isOverThreshold(),
    }
  }

  /**
   * Main entry point to consume quota.
   */
  // TODO: add verify, add usage method and
  consume(
    cost: number,
    now: number
  ): {
    allowed: boolean
    remaining: number
    retryAfterMs: number
    overThreshold: boolean
    deniedReason?: DenyReason
  } {
    if (!this.isValidUsage(cost)) {
      return {
        allowed: false,
        remaining: this.tokens,
        retryAfterMs: 0,
        overThreshold: false,
        deniedReason: "INVALID_USAGE",
      }
    }

    // 0. Check Expiration (End Date)
    if (this.config.endDate && now > this.config.endDate) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: -1,
        overThreshold: false,
        deniedReason: "ENTITLEMENT_EXPIRED",
      } // -1 indicates "Expired/Never"
    }

    if (this.isUnlimited()) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
        overThreshold: false,
      }
    }

    // Handle Refunds (Negative Cost)
    if (cost < 0) {
      const { tokens } = this.refund(cost)
      const overThreshold = this.isOverThreshold()
      return { allowed: true, remaining: tokens, retryAfterMs: 0, overThreshold }
    }

    // 1. Sync Logic (Check if we jumped to a new mathematical period)
    this.sync(now)

    // 2. Check Balance
    const currentTokens = this.tokens
    if (currentTokens >= cost) {
      const newUsage = this.calculateUsage({
        amount: cost,
        newUsage: this.usage,
      })

      // Update usage as string to avoid precision issues
      this.usage = newUsage.newUsage
      this.lastUpdated = now

      const overThreshold = this.isOverThreshold()

      return {
        allowed: true,
        remaining: this.tokens, // Recalculate after usage update
        retryAfterMs: 0,
        overThreshold,
      }
    }

    // 3. Denied
    const overThreshold = this.isOverThreshold()
    return {
      allowed: false,
      remaining: this.tokens,
      retryAfterMs: this.getTimeUntilNextPeriod(now),
      overThreshold,
      deniedReason: "LIMIT_EXCEEDED",
    }
  }

  private isValidUsage(cost: number) {
    // for negative usage that is not sum, sum_all
    // count and count_all are not affected by negative usage they are monotonic increasing
    if (cost < 0 && !["sum", "sum_all"].includes(this.config.aggregationMethod)) {
      return false
    }

    return true
  }

  /**
   * Updates the global counter based on the aggregation method
   * @param params - The parameters for the calculation
   * @param params.aggregationMethod - The aggregation method to use
   * @param params.amount - The amount to calculate the usage from
   * @param params.usage - The usage to calculate the usage from
   * @returns The usage after the calculation
   */
  private calculateUsage({
    amount,
    newUsage,
  }: {
    amount: number
    newUsage: string
  }): {
    newUsage: string
  } {
    const config = AGGREGATION_CONFIG[this.config.aggregationMethod]

    if (config.behavior === "sum") {
      newUsage = (Number(newUsage) + amount).toString()
    } else if (config.behavior === "max") {
      newUsage = Math.max(Number(newUsage), amount).toString()
    } else if (config.behavior === "last") {
      newUsage = amount.toString()
    }

    return { newUsage }
  }

  /**
   * Returns usages stats without modifying state (readonly-ish).
   * Useful for showing "You have used X of Y today" in UI.
   */
  getUsage(now = Date.now()) {
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
      effectiveStartDate: this.config.startDate, // This is the subscription anchor (immutable)
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
      if (config.behavior === "sum") {
        // Odometer Logic: Snap Anchor to Current Counter
        // Usage becomes 0 because Global - Anchor = 0
        this.usage = "0"
      }

      // Gauge Logic (Max/Last): Hard reset
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

  /**
   * Refunds tokens (e.g. failed job).
   * Decrements usage counters to keep accounting accurate.
   */
  refund(amount: number): { tokens: number } {
    if (this.isUnlimited() || amount <= 0) return { tokens: this.tokens }

    this.sync(Date.now())

    // Refund reduces usage (which increases available tokens)
    this.usage = Math.max(0, this.usageNumber - amount).toString()

    return { tokens: this.tokens }
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
    }
  }
}
