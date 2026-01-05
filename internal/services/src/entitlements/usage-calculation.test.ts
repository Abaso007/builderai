import { beforeEach, describe, expect, it, vi } from "vitest"
import { UsageMeter } from "./usage-meter"

describe("UsageMeter Calculation", () => {
  // Use a fixed timestamp for deterministic cycle calculations
  const now = new Date("2024-01-01T00:00:00Z").getTime()
  const _customerId = "cust_usage_test"
  const _projectId = "proj_usage_test"
  const _featureSlug = "usage-feature"

  // Base state for reuse
  const baseMeterState = {
    usage: "0",
    snapshotUsage: "0",
    lastReconciledId: "rec_initial",
    lastUpdated: now,
    lastCycleStart: now - 10000,
  }

  const baseConfig = {
    featureType: "usage" as const,
    capacity: 100,
    aggregationMethod: "sum" as const,
    startDate: now - 10000,
    endDate: now + 30 * 24 * 60 * 60 * 1000, // 30 days in future
    resetConfig: null,
    allowOverage: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("consume - Aggregation Methods", () => {
    it("should correctly sum positive usage", () => {
      const meter = new UsageMeter(baseConfig, { ...baseMeterState, usage: "10" })
      const result = meter.consume(20, now)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(70) // 100 - (10 + 20)
      expect(meter.toPersist().usage).toBe("30")
    })

    it("should correctly sum negative usage (reversal)", () => {
      const meter = new UsageMeter(baseConfig, { ...baseMeterState, usage: "50" })
      const result = meter.consume(-20, now)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(70) // 100 - (50 - 20)
      expect(meter.toPersist().usage).toBe("30")
    })

    it("should apply max aggregation correctly", () => {
      const maxConfig = {
        ...baseConfig,
        aggregationMethod: "max" as const,
      }

      // 1. Report higher usage
      const meter1 = new UsageMeter(maxConfig, { ...baseMeterState, usage: "10" })
      const _result1 = meter1.consume(20, now)
      expect(meter1.toPersist().usage).toBe("20") // max(10, 20)

      // 2. Report lower usage
      const meter2 = new UsageMeter(maxConfig, { ...baseMeterState, usage: "50" })
      const _result2 = meter2.consume(20, now)
      expect(meter2.toPersist().usage).toBe("50") // max(50, 20)
    })

    it("should fail validation for negative usage on max aggregation", () => {
      const maxConfig = {
        ...baseConfig,
        aggregationMethod: "max" as const,
      }

      const meter = new UsageMeter(maxConfig, { ...baseMeterState, usage: "10" })
      const result = meter.consume(-5, now)

      expect(result.allowed).toBe(false)
      expect(result.deniedReason).toBe("INVALID_USAGE")
      expect(result.message).toContain("Negative usage is not allowed")
    })

    it("should handle last aggregation method", () => {
      const lastConfig = {
        ...baseConfig,
        aggregationMethod: "last_during_period" as const,
      }

      const meter = new UsageMeter(lastConfig, { ...baseMeterState, usage: "10" })
      const result = meter.consume(25, now)

      expect(result.allowed).toBe(true)
      expect(meter.toPersist().usage).toBe("25")
    })

    it("shouldn't allow report usage for flat features", () => {
      const flatConfig = {
        ...baseConfig,
        featureType: "flat" as const,
        capacity: 0, // Capacity doesn't matter for flat
      }

      const meter = new UsageMeter(flatConfig, baseMeterState)
      const result = meter.consume(100, now)

      expect(result.allowed).toBe(false)
      expect(result.deniedReason).toBe("FLAT_FEATURE_NOT_ALLOWED_REPORT_USAGE")
      expect(result.message).toBe("Flat feature not allowed to be reported")
    })
  })

  describe("consume - Limits and Overage", () => {
    it("should attribute overage correctly when allowed", () => {
      const overageConfig = {
        ...baseConfig,
        capacity: 50,
        allowOverage: true,
      }

      const meter = new UsageMeter(overageConfig, baseMeterState)
      const result = meter.consume(70, now)

      expect(result.allowed).toBe(true)
      expect(meter.toPersist().usage).toBe("70")
      expect(result.remaining).toBe(-20)
    })

    it("should fail when limit exceeded and no overage allowed", () => {
      const strictConfig = {
        ...baseConfig,
        capacity: 50,
        allowOverage: false,
      }

      const meter = new UsageMeter(strictConfig, baseMeterState)
      const result = meter.consume(51, now)

      expect(result.allowed).toBe(false)
      expect(result.deniedReason).toBe("LIMIT_EXCEEDED")
      expect(meter.toPersist().usage).toBe("0")
    })
  })

  describe("Consumption Totals over Reset Cycles", () => {
    it("should reset usage when crossing cycle boundary", () => {
      const dailyResetConfig = {
        ...baseConfig,
        resetConfig: {
          name: "daily",
          resetInterval: "day" as const,
          resetIntervalCount: 1,
          resetAnchor: 1,
          planType: "recurring" as const,
        },
      }

      // Day 1
      const day1 = now
      const meter = new UsageMeter(dailyResetConfig, {
        ...baseMeterState,
        lastCycleStart: day1 - 1000,
      })

      meter.consume(60, day1)
      expect(meter.toPersist().usage).toBe("60")

      // Day 2 (crossing boundary)
      const day2 = day1 + 24 * 60 * 60 * 1000 + 1000
      const result = meter.consume(30, day2)

      expect(result.allowed).toBe(true)
      expect(meter.toPersist().usage).toBe("30") // Reset to 0 then +30
    })

    it("should not reset usage for lifetime scoped aggregation", () => {
      const lifetimeConfig = {
        ...baseConfig,
        aggregationMethod: "sum_all" as const,
        resetConfig: {
          name: "daily",
          resetInterval: "day" as const,
          resetIntervalCount: 1,
          resetAnchor: 1,
          planType: "recurring" as const,
        },
      }

      // Day 1
      const day1 = now
      const meter = new UsageMeter(lifetimeConfig, {
        ...baseMeterState,
        lastCycleStart: day1 - 1000,
      })

      meter.consume(60, day1)
      expect(meter.toPersist().usage).toBe("60")

      // Day 2
      const day2 = day1 + 24 * 60 * 60 * 1000 + 1000
      meter.consume(30, day2)

      expect(meter.toPersist().usage).toBe("90") // 60 + 30 (no reset)
    })
  })
})
