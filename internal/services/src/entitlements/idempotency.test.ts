import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { EntitlementState } from "@unprice/db/validators"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Idempotency & Flush", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const now = Date.now()
  const customerId = "cust_idem_123"
  const projectId = "proj_idem_123"
  const featureSlug = "idem-feature"

  const mockEntitlementState: EntitlementState = {
    id: "ent_idem_123",
    customerId,
    projectId,
    featureSlug,
    featureType: "usage",
    limit: 100,
    allowOverage: false,
    aggregationMethod: "sum",
    mergingPolicy: "sum",
    currentCycleUsage: "0",
    accumulatedUsage: "0",
    grants: [
      {
        id: "grant_idem_1",
        type: "subscription",
        effectiveAt: now - 10000,
        expiresAt: now + 10000,
        limit: 100,
        priority: 10,
        subjectType: "customer",
        subjectId: customerId,
        allowOverage: false,
        featurePlanVersionId: "fpv_1",
        realtime: false,
        subscriptionId: "sub_1",
        subscriptionItemId: "si_1",
        subscriptionPhaseId: "sp_1",
      },
    ],
    version: "v1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    nextRevalidateAt: now + 300000,
    lastSyncAt: now,
    computedAt: now,
    resetConfig: null,
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
      ingestFeaturesUsage: vi.fn().mockResolvedValue({ successful_rows: 1 }),
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

  it("should handle reportUsage idempotency", async () => {
    // Setup DB mock
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    const usageAmount = 5
    const idempotenceKey = "idem_key_123"

    // First call - should succeed and record usage
    const res1 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: usageAmount,
      timestamp: now,
      requestId: "req_1",
      idempotenceKey,
      fromCache: false,
      metadata: null,
    })
    expect(res1.allowed).toBe(true)
    expect(res1.usage).toBe(5)

    // The `sendUsageRecordsToAnalytics` DOES deduplication.
    // Let's verify flush deduplication
    const res2 = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: usageAmount, // Same usage
      timestamp: now,
      requestId: "req_2",
      idempotenceKey, // SAME key
      fromCache: true,
      metadata: null,
    })

    // In the current implementation of `reportUsage`, it just consumes.
    // It doesn't check if idempotency key was already processed in the current cycle for consumption logic itself.
    // So usage WILL increase in memory state.
    expect(res2.allowed).toBe(true)
    expect(res2.usage).toBe(10) // 5 + 5

    // Now let's flush and verify analytics only receives ONE event
    await service.flushUsageRecords()

    expect(mockAnalytics.ingestFeaturesUsage).toHaveBeenCalledTimes(1)
    // The argument to ingestFeaturesUsage should be an array with 1 element (deduplicated)
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const callArgs = (mockAnalytics.ingestFeaturesUsage as any).mock.calls[0][0]
    expect(callArgs).toHaveLength(1)
    expect(callArgs[0].idempotenceKey).toBe(idempotenceKey)
  })

  it("should flush verifications correctly", async () => {
    // Setup DB mock
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    // Create multiple verifications
    for (let i = 0; i < 5; i++) {
      await service.verify({
        customerId,
        projectId,
        featureSlug,
        timestamp: now + i,
        requestId: `req_ver_${i}`,
        fromCache: i > 0,
        metadata: null,
        performanceStart: performance.now(),
      })
    }

    // Check storage has 5 verifications
    const pending = await mockStorage.getAllVerifications()
    expect(pending.val).toHaveLength(5)

    // Flush
    await service.flushVerifications()

    // Analytics should be called with 5 items
    expect(mockAnalytics.ingestFeaturesVerification).toHaveBeenCalledTimes(1)
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const callArgs = (mockAnalytics.ingestFeaturesVerification as any).mock.calls[0][0]
    expect(callArgs).toHaveLength(5)

    // Storage should be empty
    const remaining = await mockStorage.getAllVerifications()
    expect(remaining.val).toHaveLength(0)
  })

  it("should flush usage records correctly", async () => {
    // Setup DB mock
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    // Generate distinct usage events
    for (let i = 0; i < 3; i++) {
      await service.reportUsage({
        customerId,
        projectId,
        featureSlug,
        usage: 1,
        timestamp: now + i,
        requestId: `req_usage_flush_${i}`,
        idempotenceKey: `idem_flush_${i}`, // Distinct keys
        fromCache: i > 0,
        metadata: null,
      })
    }

    // Flush
    await service.flushUsageRecords()

    // Analytics called with 3 items
    expect(mockAnalytics.ingestFeaturesUsage).toHaveBeenCalledTimes(1)
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const callArgs = (mockAnalytics.ingestFeaturesUsage as any).mock.calls[0][0]
    expect(callArgs).toHaveLength(3)

    // Storage empty
    const remaining = await mockStorage.getAllUsageRecords()
    expect(remaining.val).toHaveLength(0)
  })
})
