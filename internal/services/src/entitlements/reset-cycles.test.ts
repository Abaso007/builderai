import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { EntitlementState } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Reset Cycles", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const customerId = "cust_reset_123"
  const projectId = "proj_reset_123"
  const featureSlug = "reset-feature"

  // Dates
  const jan1 = new Date("2024-01-01T00:00:00Z").getTime()
  const jan2 = new Date("2024-01-02T00:00:00Z").getTime()
  const jan3 = new Date("2024-01-03T00:00:00Z").getTime()
  const _jan8 = new Date("2024-01-08T00:00:00Z").getTime() // Start of Week 2
  const jan9 = new Date("2024-01-09T00:00:00Z").getTime()
  const jan10 = new Date("2024-01-10T00:00:00Z").getTime()
  const _jan15 = new Date("2024-01-15T00:00:00Z").getTime() // Start of Week 3

  const mockEntitlementState: EntitlementState = {
    id: "ent_reset_123",
    customerId,
    projectId,
    featureSlug,
    featureType: "usage",
    limit: 100, // Weekly limit
    allowOverage: false,
    aggregationMethod: "sum",
    mergingPolicy: "sum",
    currentCycleUsage: "0",
    accumulatedUsage: "0",
    grants: [
      {
        id: "grant_reset_1",
        type: "subscription",
        effectiveAt: jan1,
        expiresAt: jan1 + 30 * 24 * 60 * 60 * 1000, // 30 days
        limit: 100,
        priority: 10,
        subjectType: "customer",
        subjectId: customerId,
        allowOverage: false,
        featurePlanVersionId: "fpv_reset_1",
        realtime: false,
        subscriptionId: "sub_reset_1",
        subscriptionItemId: "si_reset_1",
        subscriptionPhaseId: "sp_reset_1",
      },
    ],
    version: "v1",
    effectiveAt: jan1,
    expiresAt: jan1 + 30 * 24 * 60 * 60 * 1000,
    nextRevalidateAt: jan1 + 300000,
    lastSyncAt: jan1,
    computedAt: jan1,
    resetConfig: {
      name: "weekly-reset",
      resetInterval: "week",
      resetIntervalCount: 1,
      resetAnchor: 1, // Monday (assuming ISO week or similar, calculateCycleWindow logic dependent)
      planType: "recurring",
    },
  }

  beforeEach(async () => {
    vi.clearAllMocks()

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger

    mockAnalytics = {
      ingestFeaturesVerification: vi.fn().mockResolvedValue({ successful_rows: 1 }),
    } as unknown as Analytics

    mockDb = {
      query: {
        entitlements: {
          findFirst: vi.fn(),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ ...mockEntitlementState }]),
          })),
        })),
      })),
    } as unknown as Database

    mockCache = {
      customerEntitlement: {
        swr: vi.fn().mockImplementation(async (_key, fetcher) => {
          return await fetcher()
        }),
        set: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
      },
    } as unknown as Cache

    mockMetrics = {} as unknown as Metrics

    mockStorage = new MemoryEntitlementStorageProvider({ logger: mockLogger })
    await mockStorage.initialize()

    service = new EntitlementService({
      db: mockDb,
      storage: mockStorage,
      logger: mockLogger,
      analytics: mockAnalytics,
      waitUntil: vi.fn((promise) => promise),
      cache: mockCache,
      metrics: mockMetrics,
    })
  })

  it("should reset usage when entering a new cycle", async () => {
    // Initial State
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      metadata: null,
      createdAtM: jan1,
      updatedAtM: jan1,
    })

    // 1. Week 1 - Usage 50
    const res1 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 50,
      timestamp: jan2,
      requestId: "req_1",
      idempotenceKey: "idem_1",
      fromCache: false,
      metadata: null,
    })

    expect(res1.allowed).toBe(true)
    expect(res1.usage).toBe(50)

    // Verify storage
    let stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.currentCycleUsage).toBe("50")

    // mock the entitlement in cache
    vi.spyOn(mockCache.customerEntitlement, "swr").mockResolvedValue(Ok(mockEntitlementState))

    // 2. Week 1 - Usage 10 (Total 60)
    const res2 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 10,
      timestamp: jan3,
      requestId: "req_2",
      idempotenceKey: "idem_2",
      fromCache: true, // Use cached state
      metadata: null,
    })

    expect(res2.allowed).toBe(true)
    expect(res2.usage).toBe(60)

    stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.currentCycleUsage).toBe("60")

    // 3. Week 2 - Usage 20 (Should Reset)
    // Week 2 starts Jan 8
    const res3 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 20,
      timestamp: jan9,
      requestId: "req_3",
      idempotenceKey: "idem_3",
      fromCache: true,
      metadata: null,
    })
    expect(res3.allowed).toBe(true)
    // Should be 20 because of reset
    expect(res3.usage).toBe(20)

    stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.currentCycleUsage).toBe("20")
    // Accumulated should include previous cycle usage (60)
    expect(stored.val?.accumulatedUsage).toBe("60")

    // 4. Week 2 - Usage 10 (Total 30 in Week 2)
    // This confirms we don't reset AGAIN within Week 2
    const res4 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 10,
      timestamp: jan10,
      requestId: "req_4",
      idempotenceKey: "idem_4",
      fromCache: true,
      metadata: null,
    })
    expect(res4.allowed).toBe(true)
    expect(res4.usage).toBe(30)

    stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.currentCycleUsage).toBe("30")
    expect(stored.val?.accumulatedUsage).toBe("60")
  })

  it("should handle daily reset over a month period and expire entitlement", async () => {
    const monthStart = jan1
    const monthEnd = jan1 + 30 * 24 * 60 * 60 * 1000 // 30 days

    const dailyResetState: EntitlementState = {
      ...mockEntitlementState,
      id: "ent_daily_reset",
      resetConfig: {
        name: "daily-reset",
        resetInterval: "day",
        resetIntervalCount: 1,
        resetAnchor: 0, // 00:00:00
        planType: "recurring",
      },
      limit: 10, // Daily limit of 10
      effectiveAt: monthStart,
      expiresAt: monthEnd,
    }

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...dailyResetState,
      metadata: null,
      createdAtM: monthStart,
      updatedAtM: monthStart,
    })

    vi.spyOn(mockCache.customerEntitlement, "swr").mockResolvedValue(Ok(dailyResetState))

    let currentTimestamp = monthStart

    // Simulate 30 days of usage
    for (let day = 0; day < 30; day++) {
      // Set timestamp to mid-day (12:00)
      currentTimestamp = monthStart + day * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000

      // Report usage within limit
      const res = await service.reportUsage({
        customerId,
        projectId,
        featureSlug,
        usage: 5,
        timestamp: currentTimestamp,
        requestId: `req_day_${day}`,
        idempotenceKey: `idem_day_${day}`,
        fromCache: day > 0, // First request from DB, subsequent from cache/memory
        metadata: null,
      })

      expect(res.allowed).toBe(true)
      expect(res.usage).toBe(5) // Should be 5 every day due to reset

      // Verify storage state
      const stored = await mockStorage.get({ customerId, projectId, featureSlug })
      expect(stored.val?.currentCycleUsage).toBe("5")

      // Accumulated usage should increase by 5 from previous day (except first day is 0 accumulated from previous)
      // Day 0: accum 0
      // Day 1: accum 5
      // Day 2: accum 10 ...
      expect(stored.val?.accumulatedUsage).toBe((day * 5).toString())
    }

    // Verify accumulated usage at the end
    const stored = await mockStorage.get({ customerId, projectId, featureSlug })
    expect(stored.val?.accumulatedUsage).toBe(((30 - 1) * 5).toString())

    // Test expiration
    const expiredTimestamp = monthEnd + 1000 // 1 second after expiration

    // Spy on grants manager to verify recomputation attempt
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const computeGrantsSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")
    // Mock return empty to simulate no valid renewal found
    computeGrantsSpy.mockResolvedValue(Ok([]))

    const resExpired = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 50,
      timestamp: expiredTimestamp,
      requestId: "req_expired",
      idempotenceKey: "idem_expired",
      fromCache: true,
      metadata: null,
    })

    expect(computeGrantsSpy).toHaveBeenCalledWith({
      customerId,
      projectId,
      now: expiredTimestamp,
      usageOverrides: {
        [featureSlug]: {
          currentCycleUsage: (5).toString(),
          accumulatedUsage: ((30 - 1) * 5).toString(),
        },
      },
      featureSlug,
    })

    // Should fail with ENTITLEMENT_NOT_FOUND because recomputation found no grants
    expect(resExpired.allowed).toBe(false)
    expect(resExpired.deniedReason).toBe("ENTITLEMENT_NOT_FOUND")
  })
})
