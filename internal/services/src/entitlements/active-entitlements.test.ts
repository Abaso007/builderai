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

describe("EntitlementService - Active Entitlements & Cycle Changes", () => {
  let service: EntitlementService
  let mockDb: Database
  let mockStorage: MemoryEntitlementStorageProvider
  let mockLogger: Logger
  let mockAnalytics: Analytics
  let mockCache: Cache
  let mockMetrics: Metrics

  const customerId = "cust_active_123"
  const projectId = "proj_active_123"
  const featureSlug = "feature-a"
  const featureSlugB = "feature-b"
  const now = Date.now()

  const mockEntitlementState: EntitlementState = {
    id: "ent_1",
    customerId,
    projectId,
    featureSlug,
    featureType: "usage",
    limit: 100,
    allowOverage: false,
    aggregationMethod: "sum",
    mergingPolicy: "sum",
    currentCycleUsage: "10",
    accumulatedUsage: "50",
    grants: [],
    version: "v1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    nextRevalidateAt: now + 3600000,
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

  describe("getActiveEntitlements", () => {
    it("should handle cold start (entitlement not in storage)", async () => {
      // 1. Storage is empty initially
      const stored = await mockStorage.getAll()
      expect(stored.val).toEqual([])

      // 2. Mock computeGrantsForCustomer to return entitlement
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const computeSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")
      computeSpy.mockResolvedValue(Ok([mockEntitlementState]))

      // 3. Call getActiveEntitlements
      const result = await service.getActiveEntitlements({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val![0]).toEqual(mockEntitlementState)

      // 4. Verify grants were computed with empty overrides
      expect(computeSpy).toHaveBeenCalledWith({
        customerId,
        projectId,
        now,
        usageOverrides: {},
      })

      // 5. Verify storage is populated
      const storedAfter = await mockStorage.getAll()
      expect(storedAfter.val).toHaveLength(1)
      expect(storedAfter.val?.[0]).toEqual(mockEntitlementState)
    })

    it("should preserve usage from storage via overrides", async () => {
      // 1. Pre-populate storage with usage
      const storedState = {
        ...mockEntitlementState,
        currentCycleUsage: "99",
        accumulatedUsage: "999",
      }
      await mockStorage.set({ state: storedState })

      // 2. Mock computeGrantsForCustomer to return "clean" entitlement (as if from DB)
      // The service should inject the overrides during computation/merging inside computeGrantsForCustomer
      // But we are mocking computeGrantsForCustomer, so we just check if it was called with overrides
      // And we simulate it returning the merged result (or whatever logic computeGrantsForCustomer would do)
      // Actually, since we mock computeGrantsForCustomer, WE have to simulate the logic of applying overrides if we want the result to reflect it,
      // OR we just verify the spy was called with correct arguments.
      // The real computeGrantsForCustomer logic (which we aren't testing here, we are testing service.ts orchestration) would use the overrides.
      // So checking the spy arguments is sufficient to verify service.ts logic.

      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const computeSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")

      // We return the state we expect "DB computation" to yield.
      // Important: the service relies on computeGrantsForCustomer to APPLY the overrides.
      // So for this test to pass "end-to-end" regarding the return value, our mock should behave like the real function
      // or we just trust the spy call.
      // Let's assume the grants manager does its job and returns the state with usage applied.
      computeSpy.mockResolvedValue(Ok([storedState]))

      const result = await service.getActiveEntitlements({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()

      // Check that overrides were passed correctly
      expect(computeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          usageOverrides: {
            [featureSlug]: {
              currentCycleUsage: "99",
              accumulatedUsage: "999",
            },
          },
        })
      )
    })

    it("should reconcile features: add new, remove revoked", async () => {
      // 1. Storage has Feature A and Feature Old
      const featureOld = { ...mockEntitlementState, id: "ent_old", featureSlug: "feature-old" }
      await mockStorage.set({ state: mockEntitlementState }) // Feature A
      await mockStorage.set({ state: featureOld })

      // 2. DB has Feature A and Feature New (Feature Old is revoked)
      const featureNew = { ...mockEntitlementState, id: "ent_new", featureSlug: featureSlugB }

      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const computeSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")
      computeSpy.mockResolvedValue(Ok([mockEntitlementState, featureNew]))

      // 3. Call
      const result = await service.getActiveEntitlements({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlements = result.val!
      expect(entitlements).toHaveLength(2)

      const slugs = entitlements.map((e) => e.featureSlug).sort()
      expect(slugs).toEqual([featureSlug, featureSlugB].sort())

      // 4. Verify Storage
      const stored = await mockStorage.getAll()
      const storedSlugs = stored.val?.map((e) => e.featureSlug).sort()

      expect(storedSlugs).toEqual([featureSlug, featureSlugB].sort())
      // Feature Old should be gone
      expect(storedSlugs).not.toContain("feature-old")
    })
  })

  describe("getStateWithRevalidation (Cycle Change Edge Case)", () => {
    it("should pass usage overrides when recomputing expired entitlement", async () => {
      // 1. Setup expired entitlement in storage with usage
      const expiredState = {
        ...mockEntitlementState,
        expiresAt: now - 1000,
        currentCycleUsage: "75",
        accumulatedUsage: "100",
      }
      await mockStorage.set({ state: expiredState })

      // 2. Mock computeGrantsForCustomer (called during revalidation)
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const computeSpy = vi.spyOn((service as any).grantsManager, "computeGrantsForCustomer")

      // Return a "renewed" entitlement
      const renewedState = { ...mockEntitlementState, effectiveAt: now, expiresAt: now + 10000 }
      computeSpy.mockResolvedValue(Ok([renewedState]))

      // 3. Trigger revalidation via reportUsage (since getStateWithRevalidation is private)
      // We force a cache miss/check by passing fromCache: true, but since it's expired in storage, it triggers recomputation
      await service.reportUsage({
        customerId,
        projectId,
        featureSlug,
        usage: 1,
        timestamp: now,
        requestId: "req_1",
        idempotenceKey: "key_1",
        fromCache: true,
        metadata: null,
      })

      // 4. Verify computeGrantsForCustomer was called with usage overrides
      expect(computeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId,
          projectId,
          now,
          featureSlug,
          usageOverrides: {
            [featureSlug]: {
              currentCycleUsage: "75",
              accumulatedUsage: "100",
            },
          },
        })
      )

      // 5. Verify storage was updated with new entitlement
      const stored = await mockStorage.get({ customerId, projectId, featureSlug })
      expect(stored.val).toEqual(renewedState)
    })
  })
})
