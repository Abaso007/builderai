import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { EntitlementState } from "@unprice/db/validators"
import type { Logger } from "@unprice/logging"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { MemoryEntitlementStorageProvider } from "./memory-provider"
import { EntitlementService } from "./service"

describe("EntitlementService - Multiple Grants", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const now = Date.now()
  const customerId = "cust_multi_123"
  const projectId = "proj_multi_123"
  const featureSlug = "multi-grant-feature"

  const grantA = {
    id: "grant_A",
    type: "subscription",
    priority: 10,
    limit: 100,
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    allowOverage: false,
    featurePlanVersionId: "fpv_A",
    subjectType: "customer",
    subjectId: customerId,
    realtime: false,
    subscriptionId: "sub_A",
    subscriptionItemId: "item_A",
    subscriptionPhaseId: "phase_A",
  }

  const grantB = {
    id: "grant_B",
    type: "addon",
    priority: 20,
    limit: 50,
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    allowOverage: false,
    featurePlanVersionId: "fpv_B",
    subjectType: "customer",
    subjectId: customerId,
    realtime: false,
    subscriptionId: "sub_B",
    subscriptionItemId: "item_B",
    subscriptionPhaseId: "phase_B",
  }

  const mockEntitlementState: EntitlementState = {
    id: "ent_multi_123",
    customerId,
    projectId,
    featureSlug,
    featureType: "usage",
    limit: 150, // Sum of limits (100 + 50)
    allowOverage: false,
    aggregationMethod: "sum",
    mergingPolicy: "sum",
    currentCycleUsage: "0",
    accumulatedUsage: "0",
    grants: [grantA, grantB],
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

  it("should attribute consumption by priority", async () => {
    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...mockEntitlementState,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    // Report usage of 60
    // Grant B (priority 20, limit 50) should be consumed first
    // Grant A (priority 10, limit 100) should take remaining 10
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 60,
      timestamp: now,
      requestId: "req_prio_1",
      idempotenceKey: "idem_prio_1",
      fromCache: false,
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.usage).toBe(60)
    expect(result.consumedFrom).toHaveLength(2)

    const consumedB = result.consumedFrom.find((c) => c.grantId === grantB.id)
    const consumedA = result.consumedFrom.find((c) => c.grantId === grantA.id)

    expect(consumedB).toBeDefined()
    expect(consumedB!.amount).toBe(50) // Full limit of B

    expect(consumedA).toBeDefined()
    expect(consumedA!.amount).toBe(10) // Remaining 10 from A
  })

  it("should only consume from active grants based on dates", async () => {
    const futureGrant = {
      ...grantB,
      id: "grant_future",
      effectiveAt: now + 5000, // Starts in future
      expiresAt: now + 15000,
    }

    const stateWithFuture: EntitlementState = {
      ...mockEntitlementState,
      grants: [grantA, futureGrant],
      limit: 150, // Assuming recomputation would include it, but verify filters
    }

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...stateWithFuture,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 60,
      timestamp: now, // Before futureGrant starts
      requestId: "req_date_1",
      idempotenceKey: "idem_date_1",
      fromCache: false,
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    // Should only consume from Grant A
    expect(result.consumedFrom).toHaveLength(1)
    expect(result.consumedFrom[0]).toBeDefined()
    expect(result.consumedFrom[0]!.grantId).toBe(grantA.id)
    expect(result.consumedFrom[0]!.amount).toBe(60)
  })

  it("should handle expired grants correctly", async () => {
    const expiredGrant = {
      ...grantB,
      id: "grant_expired",
      effectiveAt: now - 20000,
      expiresAt: now - 10000, // Expired
    }

    const stateWithExpired: EntitlementState = {
      ...mockEntitlementState,
      grants: [grantA, expiredGrant],
    }

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...stateWithExpired,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 60,
      timestamp: now,
      requestId: "req_exp_1",
      idempotenceKey: "idem_exp_1",
      fromCache: false,
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    // Should only consume from Grant A (active)
    expect(result.consumedFrom).toHaveLength(1)
    expect(result.consumedFrom[0]).toBeDefined()
    expect(result.consumedFrom[0]!.grantId).toBe(grantA.id)
  })

  it("should allow overage if at least one active grant allows it", async () => {
    const grantStrict = {
      ...grantA,
      id: "grant_strict",
      limit: 10,
      allowOverage: false,
    }

    const grantFlexible = {
      ...grantB,
      id: "grant_flexible",
      limit: 10,
      allowOverage: true,
    }

    const stateMixed: EntitlementState = {
      ...mockEntitlementState,
      grants: [grantStrict, grantFlexible],
      mergingPolicy: "sum", // Sum limits = 20
      allowOverage: true, // Computed property from grants
    }

    vi.spyOn(mockDb.query.entitlements, "findFirst").mockResolvedValue({
      ...stateMixed,
      metadata: null,
      createdAtM: now,
      updatedAtM: now,
    })

    // Usage 30 > Limit 20
    const result = await service.reportUsage({
      customerId,
      projectId,
      featureSlug,
      usage: 30,
      timestamp: now,
      requestId: "req_overage_1",
      idempotenceKey: "idem_overage_1",
      fromCache: false,
      metadata: null,
    })

    expect(result.allowed).toBe(true)
    expect(result.notifiedOverLimit).toBe(true)

    // Verify attribution
    // Flexible (Prio 20) takes 10 (its limit)
    // Strict (Prio 10) takes 10 (its limit)
    // Remaining 10 attributed? The loop breaks when remaining <= 0 or runs out of grants.
    // If runs out of grants and remaining > 0, where does it go?
    // In `attributeConsumption`:
    // It iterates grants. `toAttribute = min(remaining, grant.limit)`.
    // If grant.limit is null (unlimited), it takes all.
    // If both have limits, it consumes up to limit.
    // Any remaining amount is NOT attributed to a specific grant ID if limits are exhausted.

    const consumedFlexible = result.consumedFrom.find((c) => c.grantId === grantFlexible.id)
    const consumedStrict = result.consumedFrom.find((c) => c.grantId === grantStrict.id)

    expect(consumedFlexible).toBeDefined()
    expect(consumedFlexible!.amount).toBe(20) // 10 limit + 10 overage
    expect(consumedStrict).toBeDefined()
    expect(consumedStrict!.amount).toBe(10)

    const totalAttributed = result.consumedFrom.reduce((acc, c) => acc + c.amount, 0)
    expect(totalAttributed).toBe(30)
    // Note: Overage is now attributed to the flexible grant
  })
})
