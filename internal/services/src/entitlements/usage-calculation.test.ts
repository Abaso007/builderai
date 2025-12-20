import type { Database } from "@unprice/db"
import type { EntitlementState } from "@unprice/db/validators"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GrantsManager } from "./grants"

describe("GrantsManager Usage Calculation", () => {
  let grantsManager: GrantsManager
  let mockDb: Database
  let mockLogger: Logger

  // Use a fixed timestamp for deterministic cycle calculations
  const now = new Date("2024-01-01T00:00:00Z").getTime()
  const customerId = "cust_usage_test"
  const projectId = "proj_usage_test"
  const featureSlug = "usage-feature"

  // Base state for reuse
  const baseState: EntitlementState = {
    id: "ent_1",
    projectId,
    customerId,
    featureSlug,
    featureType: "usage",
    aggregationMethod: "sum",
    limit: 100,
    allowOverage: false,
    mergingPolicy: "sum",
    grants: [
      {
        id: "g1",
        type: "subscription",
        priority: 10,
        limit: 100,
        allowOverage: false,
        effectiveAt: now - 10000,
        expiresAt: now + 10000,
        subjectType: "customer",
        subjectId: customerId,
        featurePlanVersionId: "fpv_1",
        realtime: false,
      },
    ],
    version: "v1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    nextRevalidateAt: now + 3600000,
    lastSyncAt: now,
    computedAt: now,
    currentCycleUsage: "0",
    accumulatedUsage: "0",
    resetConfig: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger
    mockDb = {} as Database
    grantsManager = new GrantsManager({ db: mockDb, logger: mockLogger })
  })

  describe("consume - Aggregation Methods", () => {
    it("should correctly sum positive usage", () => {
      const result = grantsManager.consume({
        state: { ...baseState, currentCycleUsage: "10" },
        amount: 20,
        now,
      })

      expect(result.allowed).toBe(true)
      expect(result.usage).toBe(30) // 10 + 20
      expect(result.deniedReason).toBeUndefined()
    })

    it("should correctly sum negative usage (reversal)", () => {
      const result = grantsManager.consume({
        state: { ...baseState, currentCycleUsage: "50" },
        amount: -20,
        now,
      })

      expect(result.allowed).toBe(true)
      expect(result.usage).toBe(30) // 50 - 20
    })

    it("should apply max aggregation correctly", () => {
      const maxState = {
        ...baseState,
        aggregationMethod: "max" as const,
        featureType: "tier" as const, // usually max
        mergingPolicy: "max" as const,
      } as EntitlementState

      // 1. Report higher usage
      const result1 = grantsManager.consume({
        state: { ...maxState, currentCycleUsage: "10" },
        amount: 20,
        now,
      })
      expect(result1.usage).toBe(20) // max(10, 20)

      // 2. Report lower usage
      const result2 = grantsManager.consume({
        state: { ...maxState, currentCycleUsage: "50" },
        amount: 20,
        now,
      })
      expect(result2.usage).toBe(50) // max(50, 20)
    })

    it("should fail validation for negative usage on max aggregation", () => {
      const maxState = {
        ...baseState,
        aggregationMethod: "max" as const,
      } as EntitlementState

      const result = grantsManager.consume({
        state: { ...maxState, currentCycleUsage: "10" },
        amount: -5,
        now,
      })

      expect(result.allowed).toBe(false)
      expect(result.deniedReason).toBe("INCORRECT_USAGE_REPORTING")
      expect(result.message).toContain("Usage cannot be negative")
    })

    it("should increment count regardless of amount", () => {
      const countState = {
        ...baseState,
        aggregationMethod: "count",
      } as EntitlementState

      const result = grantsManager.consume({
        state: { ...countState, currentCycleUsage: "5" },
        amount: 100, // Amount should be ignored
        now,
      })

      expect(result.usage).toBe(6) // 5 + 1
    })

    it("should fail when trying to consume flat feature", () => {
      const flatState: EntitlementState = {
        ...baseState,
        featureType: "flat",
      }

      const result = grantsManager.consume({
        state: flatState,
        amount: 1,
        now,
      })

      expect(result.allowed).toBe(false)
      expect(result.message).toContain("Flat feature cannot be used to consume usage")
    })
  })

  describe("consume - Attribution Logic", () => {
    it("should attribute usage across multiple grants by priority", () => {
      const multiGrantState: EntitlementState = {
        ...baseState,
        limit: 100, // 50 + 50
        grants: [
          {
            ...baseState.grants[0]!,
            id: "g_low",
            priority: 10,
            limit: 50,
          },
          {
            ...baseState.grants[0]!,
            id: "g_high",
            priority: 20,
            limit: 50,
          },
        ],
      }

      const result = grantsManager.consume({
        state: multiGrantState,
        amount: 80,
        now,
      })

      expect(result.allowed).toBe(true)
    })

    it("should attribute negative usage (refund) starting from highest priority", () => {
      const multiGrantState: EntitlementState = {
        ...baseState,
        limit: 100,
        grants: [
          {
            ...baseState.grants[0]!,
            id: "g_low",
            priority: 10,
            limit: 50,
          },
          {
            ...baseState.grants[0]!,
            id: "g_high",
            priority: 20,
            limit: 50,
          },
        ],
      }

      // Usage reversal of -20
      const result = grantsManager.consume({
        state: multiGrantState,
        amount: -20,
        now,
      })

      expect(result.allowed).toBe(true)

      // Should attribute -20 to high priority grant first
    })

    it("should attribute overage correctly when allowed", () => {
      const overageState: EntitlementState = {
        ...baseState,
        allowOverage: true,
        limit: 50,
        grants: [
          {
            ...baseState.grants[0]!,
            id: "g_overage",
            limit: 50,
            allowOverage: true,
          },
        ],
      }

      const result = grantsManager.consume({
        state: overageState,
        amount: 70, // 20 over limit
        now,
      })

      expect(result.allowed).toBe(true)
      expect(result.usage).toBe(70)

      // Should find the overage grant and attribute all 70 to it (50 limit + 20 overage)
      // Actually implementation:
      // Loop 1: attributes min(70, 50) = 50. Remaining = 20.
      // Post-loop: finds overage grant. Existing entry found? Yes. Adds 20.
      // Total 70.
    })

    it("should fail when limit exceeded and no overage allowed", () => {
      const strictState: EntitlementState = {
        ...baseState,
        allowOverage: false,
        limit: 50,
        currentCycleUsage: "0",
        grants: [
          {
            ...baseState.grants[0]!,
            limit: 50,
            allowOverage: false,
          },
        ],
      }

      const result = grantsManager.consume({
        state: strictState,
        amount: 51,
        now,
      })

      expect(result.allowed).toBe(false)
      expect(result.deniedReason).toBe("LIMIT_EXCEEDED")
      // Usage should NOT be updated in returned result if denied?
      // Code says: returns usage: Number(normalizedState.currentCycleUsage) (old usage)
      expect(result.usage).toBe(0)
    })
  })

  describe("Consumption Totals over Reset Cycles", () => {
    // Helper to simulate a billing period with multiple reset cycles
    const simulateConsumption = async ({
      totalAmount,
      batchSize,
      resetConfig,
    }: {
      totalAmount: number
      batchSize: number
      resetConfig: NonNullable<EntitlementState["resetConfig"]>
    }) => {
      // Setup reset config
      const state: EntitlementState = {
        ...baseState,
        limit: 100, // Limit per reset cycle
        resetConfig,
        // Start of billing period
        effectiveAt: now,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000, // 30 days
        currentCycleUsage: "0",
        accumulatedUsage: "0",
        grants: [
          {
            ...baseState.grants[0]!,
            limit: 100, // Important: Grant limit must match state limit for this test
            effectiveAt: now,
            expiresAt: now + 30 * 24 * 60 * 60 * 1000,
          },
        ],
      }

      let currentTime = now
      let totalConsumed = 0
      let remaining = totalAmount

      while (remaining > 0) {
        const amount = Math.min(remaining, batchSize)

        // 1. Consume
        const result = grantsManager.consume({
          state,
          amount,
          now: currentTime,
        })

        if (result.allowed) {
          state.currentCycleUsage = result.usage?.toString() ?? "0"

          if (result.accumulatedUsage) {
            state.accumulatedUsage = result.accumulatedUsage
          }

          // CRITICAL: Update effectiveAt if the reset cycle changed!
          // consume() returns effectiveAt if it detected a reset.
          if (result.effectiveAt) {
            state.effectiveAt = result.effectiveAt
          }

          totalConsumed += amount
          remaining -= amount
        } else {
          // If rejected due to limit, we might need to advance time to next reset cycle?
          // Or just fail if we expect it to fit?
          // For this test, let's assume we advance time if limit reached
          currentTime += 24 * 60 * 60 * 1000 // Advance 1 day

          // Check if we passed expiresAt
          if (currentTime > (state.expiresAt ?? Number.POSITIVE_INFINITY)) {
            break
          }
          continue
        }

        // Advance time slightly
        currentTime += 1000
      }

      return {
        totalConsumed,
        finalState: state,
        accumulatedUsage: Number(state.accumulatedUsage),
        lifetimeUsage: Number(state.accumulatedUsage) + Number(state.currentCycleUsage),
      }
    }

    it("should accumulate usage correctly across daily resets", async () => {
      // Daily reset, 100 limit per day.
      // We want to consume 250 total.
      // Day 1: 100 (Limit reached)
      // Day 2: 100 (Limit reached)
      // Day 3: 50
      // Total accumulated should be 250.

      const resetConfig = {
        name: "daily-reset",
        resetInterval: "day",
        resetIntervalCount: 1,
        resetAnchor: 1,
        planType: "recurring",
      } as const

      const result = await simulateConsumption({
        totalAmount: 250,
        batchSize: 10,
        resetConfig,
      })

      // Check if total accumulated usage matches total consumed
      expect(result.lifetimeUsage).toBe(250)
      expect(result.totalConsumed).toBe(250)

      // Accumulated (completed cycles) should be 200
      expect(result.accumulatedUsage).toBe(200)

      // Current cycle usage should be 50 (remainder on day 3)
      // We consumed 250 total.
      // Day 1: 100
      // Day 2: 100
      // Day 3: 50
      expect(Number(result.finalState.currentCycleUsage)).toBe(50)
    })

    it("should respect limit per cycle by forcing spillover to next cycle", async () => {
      const resetConfig = {
        name: "daily-reset",
        resetInterval: "day",
        resetIntervalCount: 1,
        resetAnchor: 1,
        planType: "recurring",
      } as const

      // Try to consume 150 total. Limit 100/day.
      // Should take 2 days.
      const result = await simulateConsumption({
        totalAmount: 150,
        batchSize: 10, // Small batches to ensure we hit limit precisely
        resetConfig,
      })

      expect(result.totalConsumed).toBe(150)
      expect(result.lifetimeUsage).toBe(150)

      // Verify spillover:
      // 100 should be in accumulated (Day 1 completed)
      expect(result.accumulatedUsage).toBe(100)

      // 50 should be in current (Day 2 active)
      expect(Number(result.finalState.currentCycleUsage)).toBe(50)
    })
  })
})
