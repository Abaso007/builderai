import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import * as fc from "fast-check"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GrantsManager } from "./grants"

describe("GrantsManager", () => {
  let grantsManager: GrantsManager
  let mockDb: Database
  let mockLogger: Logger
  let txInsertValuesMock: ReturnType<typeof vi.fn>
  let txQueryEntitlementsFindFirstMock: ReturnType<typeof vi.fn>
  let txUpdateSetMock: ReturnType<typeof vi.fn>
  let txUpdateWhereMock: ReturnType<typeof vi.fn>
  let txUpdateReturningMock: ReturnType<typeof vi.fn>

  const now = Date.now()
  const customerId = "cust_grants_123"
  const projectId = "proj_grants_123"
  const featureSlug = "merge-test-feature"

  // Base grant object for reuse
  const baseGrant = {
    id: "grant_base",
    createdAtM: now - 20_000,
    updatedAtM: now - 10_000,
    projectId,
    name: "grant_base",
    subjectType: "customer" as const,
    subjectId: customerId,
    type: "subscription" as const,
    featurePlanVersionId: "fpv_1",
    effectiveAt: now - 10000,
    expiresAt: now + 10000,
    limit: 100,
    units: 1,
    overageStrategy: "none" as const,
    metadata: null,
    deleted: false,
    deletedAt: null,
    autoRenew: true,
    priority: 10,
    featurePlanVersion: {
      id: "fpv_1",
      createdAtM: now - 20_000,
      updatedAtM: now - 10_000,
      projectId,
      planVersionId: "pv_1",
      type: "feature" as const,
      featureId: "feat_1",
      order: 1,
      defaultQuantity: 1,
      limit: 100,
      feature: {
        id: "feat_1",
        createdAtM: now - 20_000,
        updatedAtM: now - 10_000,
        projectId,
        slug: featureSlug,
        code: 1,
        unitOfMeasure: "units",
        title: "Merge Test Feature",
        description: null,
        meterConfig: null,
      },
      featureType: "usage" as const,
      unitOfMeasure: "units",
      meterConfig: {
        eventId: "event_usage",
        eventSlug: "merge-test-feature",
        aggregationMethod: "sum" as const,
        aggregationField: "value",
      },
      config: {
        usageMode: "unit" as const,
        price: {
          dinero: {
            amount: 0,
            currency: {
              code: "USD",
              base: 10,
              exponent: 2,
            },
            scale: 2,
          },
          displayAmount: "0.00",
        },
      },
      billingConfig: {
        name: "billing",
        billingInterval: "month" as const,
        billingIntervalCount: 1,
        billingAnchor: 1,
        planType: "recurring" as const,
      },
      resetConfig: {
        name: "billing",
        resetInterval: "month" as const,
        resetIntervalCount: 1,
        planType: "recurring" as const,
        resetAnchor: 1,
      },
      metadata: {
        realtime: false,
        notifyUsageThreshold: 95,
        overageStrategy: "none" as const,
        blockCustomer: false,
        hidden: false,
      },
    },
    anchor: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()

    txQueryEntitlementsFindFirstMock = vi.fn().mockResolvedValue(null)
    txUpdateReturningMock = vi.fn().mockResolvedValue([])
    txUpdateWhereMock = vi.fn().mockImplementation(() => ({
      returning: txUpdateReturningMock,
    }))
    txUpdateSetMock = vi.fn().mockImplementation(() => ({
      where: txUpdateWhereMock,
    }))
    txInsertValuesMock = vi.fn().mockImplementation((values) => ({
      returning: vi.fn().mockResolvedValue([{ ...values }]),
    }))

    mockLogger = {
      set: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger

    mockDb = {
      query: {
        customers: {
          findFirst: vi.fn(),
        },
        grants: {
          findMany: vi.fn(),
        },
        entitlements: {
          findFirst: vi.fn(),
        },
      },
      transaction: vi.fn(async (callback) =>
        callback({
          query: {
            entitlements: {
              findFirst: txQueryEntitlementsFindFirstMock,
            },
          },
          update: vi.fn(() => ({
            set: txUpdateSetMock,
          })),
          insert: vi.fn(() => ({
            values: txInsertValuesMock,
          })),
        })
      ),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "ent_new" }]),
          })),
        })),
      })),
    } as unknown as Database

    grantsManager = new GrantsManager({ db: mockDb, logger: mockLogger })
  })

  // Helper to mock DB responses
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const setupMocks = (grantsList: any[]) => {
    // Mock customer subscription (always found)
    vi.spyOn(mockDb.query.customers, "findFirst").mockResolvedValue({
      subscriptions: [{ phases: [{ planVersion: { plan: { id: "plan_1" }, id: "pv_1" } }] }],
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    } as any)

    // We should only return the list ONCE, or filter by arguments if possible.
    // Or just mock implementation to return empty list for subsequent calls.
    let callCount = 0
    vi.spyOn(mockDb.query.grants, "findMany").mockImplementation(() => {
      if (callCount === 0) {
        callCount++
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        return grantsList as any
      }
      return []
    })
  }

  describe("computeGrantsForCustomer - Merge Rules", () => {
    it("should sum limits for usage features", async () => {
      const grants = [
        {
          ...baseGrant,
          id: "g1",
          limit: 100,
          priority: 10,
          featurePlanVersion: { ...baseGrant.featurePlanVersion, featureType: "usage" as const },
        },
        {
          ...baseGrant,
          id: "g2",
          limit: 50,
          priority: 20,
          featurePlanVersion: { ...baseGrant.featurePlanVersion, featureType: "usage" as const },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.limit).toBe(150) // 100 + 50
      expect(entitlement!.mergingPolicy).toBe("sum")

      // Verify the materialized snapshot preserves the business window bounds.
      expect(grants[0]).toBeDefined()
      expect(grants[1]).toBeDefined()
      const minStart = Math.min(grants[0]!.effectiveAt, grants[1]!.effectiveAt)
      const maxEnd = Math.max(grants[0]!.expiresAt, grants[1]!.expiresAt)
      expect(entitlement!.effectiveAt).toBe(minStart)
      expect(entitlement!.expiresAt).toBe(maxEnd)
      expect(txUpdateSetMock.mock.calls[0]?.[0]).toEqual({
        isCurrent: false,
        updatedAtM: expect.any(Number),
      })

      // Verify feature slug and type
      expect(entitlement!.featureSlug).toBe(featureSlug)
      expect(entitlement!.featureType).toBe("usage")
      expect(entitlement!.meterConfig?.aggregationMethod).toBe("sum")
    })

    it("reuses the current entitlement snapshot when version and window are unchanged", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(now)

      try {
        const grants = [
          {
            ...baseGrant,
            id: "g1",
            limit: 100,
          },
        ]

        setupMocks(grants)

        const firstResult = await grantsManager.computeGrantsForCustomer({
          customerId,
          projectId,
          now,
        })

        expect(firstResult.err).toBeUndefined()
        const firstEntitlement = firstResult.val![0]!
        const refreshTime = now + 60_000

        txQueryEntitlementsFindFirstMock.mockResolvedValue({
          ...firstEntitlement,
          id: "ent_existing",
          isCurrent: true,
        })
        txUpdateReturningMock.mockResolvedValue([
          {
            ...firstEntitlement,
            id: "ent_existing",
            isCurrent: true,
            updatedAtM: refreshTime,
          },
        ])

        setupMocks(grants)
        vi.setSystemTime(refreshTime)

        const secondResult = await grantsManager.computeGrantsForCustomer({
          customerId,
          projectId,
          now: refreshTime,
        })

        expect(secondResult.err).toBeUndefined()
        expect(txInsertValuesMock).toHaveBeenCalledTimes(1)
        expect(txUpdateSetMock).toHaveBeenLastCalledWith({
          updatedAtM: refreshTime,
        })
        expect(secondResult.val?.[0]).toEqual(
          expect.objectContaining({
            id: "ent_existing",
            effectiveAt: firstEntitlement.effectiveAt,
            expiresAt: firstEntitlement.expiresAt,
          })
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it("preserves the resolved trial and paid window starts when materializing snapshots", async () => {
      const phaseStart = Date.UTC(2026, 2, 1)
      const trialEndsAt = Date.UTC(2026, 2, 15)
      const phaseEnd = Date.UTC(2026, 3, 1)

      const trialGrant = {
        ...baseGrant,
        id: "g_trial",
        type: "trial" as const,
        effectiveAt: phaseStart,
        expiresAt: trialEndsAt,
      }
      const paidGrant = {
        ...baseGrant,
        id: "g_paid",
        type: "subscription" as const,
        effectiveAt: trialEndsAt,
        expiresAt: phaseEnd,
      }

      setupMocks([trialGrant])
      const trialResult = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now: phaseStart + 1_000,
      })

      setupMocks([paidGrant])
      const paidResult = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now: trialEndsAt + 1_000,
      })

      expect(trialResult.err).toBeUndefined()
      expect(paidResult.err).toBeUndefined()
      expect(trialResult.val?.[0]?.effectiveAt).toBe(phaseStart)
      expect(trialResult.val?.[0]?.expiresAt).toBe(trialEndsAt)
      expect(paidResult.val?.[0]?.effectiveAt).toBe(trialEndsAt)
      expect(paidResult.val?.[0]?.expiresAt).toBe(phaseEnd)
    })

    it("should take max limit for tier features", async () => {
      const tierFeature = { ...baseGrant.featurePlanVersion, featureType: "tier" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g1",
          limit: 100,
          priority: 10,
          featurePlanVersion: tierFeature,
        },
        {
          ...baseGrant,
          id: "g2",
          limit: 500,
          priority: 20,
          featurePlanVersion: tierFeature,
        },
        {
          ...baseGrant,
          id: "g3",
          limit: 50,
          priority: 5,
          featurePlanVersion: tierFeature,
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.limit).toBe(500) // Max of 100, 500, 50
      expect(entitlement!.mergingPolicy).toBe("max")

      expect(entitlement!.meterConfig).toBeNull()

      // Verify only the winning grant is kept in the entitlement
      expect(entitlement!.grants).toHaveLength(1)
      expect(entitlement!.grants[0]!.id).toBe("g2") // g2 has limit 500
    })

    it("should replace limits for flat features (highest priority wins)", async () => {
      const flatFeature = { ...baseGrant.featurePlanVersion, featureType: "flat" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g_low",
          limit: 100,
          priority: 10,
          featurePlanVersion: flatFeature,
        },
        {
          ...baseGrant,
          id: "g_high",
          limit: 999,
          priority: 100, // Highest priority
          featurePlanVersion: flatFeature,
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.limit).toBe(999)
      expect(entitlement!.mergingPolicy).toBe("replace")

      // Verify only the winning grant is kept in the entitlement
      expect(entitlement!.grants).toHaveLength(1)
      expect(entitlement!.grants[0]!.id).toBe("g_high") // g_high has priority 100

      expect(entitlement!.resetConfig).toBeNull()
    })

    it("should allow overage if ANY grant allows it (sum policy)", async () => {
      const usageFeature = { ...baseGrant.featurePlanVersion, featureType: "usage" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g_strict",
          limit: 100,
          featurePlanVersion: {
            ...usageFeature,
            metadata: { overageStrategy: "none" as const },
          },
        },
        {
          ...baseGrant,
          id: "g_loose",
          limit: 50,
          featurePlanVersion: {
            ...usageFeature,
            metadata: { overageStrategy: "always" as const },
          },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.metadata?.overageStrategy).toBe("always")
    })

    it("should reject non-fungible grants with different meter configs", async () => {
      const grants = [
        {
          ...baseGrant,
          id: "g_input_tokens",
          limit: 100,
          featurePlanVersion: {
            ...baseGrant.featurePlanVersion,
            meterConfig: {
              ...baseGrant.featurePlanVersion.meterConfig,
              aggregationField: "input_tokens",
            },
          },
        },
        {
          ...baseGrant,
          id: "g_output_tokens",
          limit: 50,
          priority: 20,
          featurePlanVersion: {
            ...baseGrant.featurePlanVersion,
            meterConfig: {
              ...baseGrant.featurePlanVersion.meterConfig,
              aggregationField: "output_tokens",
            },
          },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.val).toBeUndefined()
      expect(result.err).toBeDefined()
      expect(result.err?.message).toContain('feature "merge-test-feature"')
      expect(result.err?.message).toContain("fungible")
      expect(result.err?.message).toContain("meterConfig")
    })

    it("should reject non-fungible grants with different reset periods", async () => {
      const grants = [
        {
          ...baseGrant,
          id: "g_monthly",
          limit: 100,
        },
        {
          ...baseGrant,
          id: "g_yearly",
          limit: 50,
          priority: 20,
          featurePlanVersion: {
            ...baseGrant.featurePlanVersion,
            resetConfig: {
              ...baseGrant.featurePlanVersion.resetConfig,
              name: "yearly",
              resetInterval: "year" as const,
              resetIntervalCount: 1,
            },
          },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.val).toBeUndefined()
      expect(result.err).toBeDefined()
      expect(result.err?.message).toContain("Non-fungible grants")
      expect(result.err?.message).toContain("resetConfig")
    })

    it("should allow overage if ANY grant allows it (max policy)", async () => {
      const tierFeature = { ...baseGrant.featurePlanVersion, featureType: "tier" as const }
      const grants = [
        {
          ...baseGrant,
          id: "g_strict",
          limit: 100,
          featurePlanVersion: {
            ...tierFeature,
            metadata: { overageStrategy: "none" as const },
          },
        },
        {
          ...baseGrant,
          id: "g_loose",
          limit: 50,
          featurePlanVersion: {
            ...tierFeature,
            metadata: { overageStrategy: "always" as const },
          },
        },
      ]

      setupMocks(grants)

      const result = await grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      const entitlement = result.val![0]
      expect(entitlement).toBeDefined()
      expect(entitlement!.metadata?.overageStrategy).toBe("always")
    })

    it("should require ALL grants to allow overage for min policy", async () => {
      const feature = {
        ...baseGrant.featurePlanVersion,
        featureType: "usage" as const,
        metadata: { overageStrategy: "always" as const },
      }
      const grantsData = [
        {
          id: "g1",
          type: "subscription" as const,
          name: "g1",
          effectiveAt: now,
          expiresAt: now + 1000,
          limit: 100,
          priority: 10,
          featurePlanVersionId: "fpv1",
          featurePlanVersion: {
            ...feature,
            metadata: { overageStrategy: "always" as const },
          },
          subjectId: customerId,
          subjectType: "customer" as const,
          projectId,
          anchor: 1,
        },
        {
          id: "g2",
          type: "subscription" as const,
          name: "g2",
          effectiveAt: now,
          expiresAt: now + 1000,
          limit: 50,
          priority: 20,
          featurePlanVersionId: "fpv1",
          featurePlanVersion: {
            ...feature,
            metadata: { overageStrategy: "none" as const },
          },
          subjectId: customerId,
          subjectType: "customer" as const,
          projectId,
          anchor: 1,
        },
      ]

      const merged = grantsManager.mergeGrants({
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        grants: grantsData as any,
        policy: "min",
      })

      expect(merged.limit).toBe(50)
    })

    it("Property-based test: Highest priority grant always wins in 'replace' policy", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.uuid(),
              priority: fc.integer({ min: 0, max: 1000 }),
              limit: fc.integer({ min: 1, max: 10000 }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (grantsSnapshotData) => {
            const sorted = [...grantsSnapshotData].sort((a, b) => b.priority - a.priority)
            const highestPriority = sorted[0]!

            const merged = grantsManager.mergeGrants({
              // biome-ignore lint/suspicious/noExplicitAny: <explanation>
              grants: grantsSnapshotData as any,
              policy: "replace",
            })

            expect(merged.limit).toBe(highestPriority.limit)
          }
        )
      )
    })
  })

  describe("renewGrantsForCustomer", () => {
    it("should renew auto-renewing grants that are not trial or subscription", async () => {
      const grantToRenew = {
        ...baseGrant,
        id: "g_addon",
        type: "addon" as const,
        autoRenew: true,
        effectiveAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        expiresAt: now + 1000, // Grant is still active
      }

      setupMocks([grantToRenew])

      // Mock createGrant (insert)
      vi.spyOn(mockDb, "insert").mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...grantToRenew, id: "g_addon_renewed" }]),
          }),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      } as any)

      const result = await grantsManager.renewGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val?.[0]?.id).toBe("g_addon_renewed")
    })

    it("should not renew trial or subscription grants", async () => {
      const grants = [
        { ...baseGrant, id: "g_sub", type: "subscription" as const, autoRenew: true },
        { ...baseGrant, id: "g_trial", type: "trial" as const, autoRenew: true },
      ]

      setupMocks(grants)

      const result = await grantsManager.renewGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(0)
    })
  })

  describe("resolveIngestionStatesFromGrants", () => {
    it("keeps the stream coverage anchored across a continuous same-signature grant chain", async () => {
      const march1 = Date.UTC(2026, 2, 1)
      const march15 = Date.UTC(2026, 2, 15)
      const march31 = Date.UTC(2026, 2, 31)
      const march20 = Date.UTC(2026, 2, 20)

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp: march20,
        grants: [
          {
            ...baseGrant,
            id: "g_chain_1",
            limit: 100,
            effectiveAt: march1,
            expiresAt: march15,
          },
          {
            ...baseGrant,
            id: "g_chain_2",
            limit: 50,
            effectiveAt: march15,
            expiresAt: march31,
          },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val?.[0]).toEqual(
        expect.objectContaining({
          activeGrantIds: ["g_chain_2"],
          featureSlug,
          limit: 50,
          streamStartAt: march1,
          streamEndAt: march31,
        })
      )
      expect(result.val?.[0]?.streamId).toContain("stream_")
    })

    it("rejects active stacked grants that disagree on meter configuration", async () => {
      const timestamp = Date.UTC(2026, 2, 20)

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp,
        grants: [
          {
            ...baseGrant,
            id: "g_meter_a",
            effectiveAt: timestamp - 10_000,
            expiresAt: timestamp + 10_000,
          },
          {
            ...baseGrant,
            id: "g_meter_b",
            effectiveAt: timestamp - 5_000,
            expiresAt: timestamp + 5_000,
            featurePlanVersion: {
              ...baseGrant.featurePlanVersion,
              meterConfig: {
                ...baseGrant.featurePlanVersion.meterConfig,
                aggregationField: "other_value",
              },
            },
          },
        ],
      })

      expect(result.err).toBeDefined()
      expect(result.err?.message).toContain("Non-fungible grants")
    })

    it("derives dayOfCreation reset anchors from grant effectiveAt for daily reset configs", async () => {
      const effectiveAt = Date.UTC(2026, 2, 24, 15, 30, 0)
      const timestamp = effectiveAt + 60_000

      const result = await grantsManager.resolveIngestionStatesFromGrants({
        customerId,
        projectId,
        timestamp,
        grants: [
          {
            ...baseGrant,
            id: "g_daily_day_of_creation",
            anchor: 24, // subscription phase monthly anchor; should not leak into daily reset config
            effectiveAt,
            expiresAt: effectiveAt + 24 * 60 * 60 * 1_000,
            featurePlanVersion: {
              ...baseGrant.featurePlanVersion,
              resetConfig: {
                ...baseGrant.featurePlanVersion.resetConfig,
                name: "daily",
                resetInterval: "day",
                resetIntervalCount: 1,
                resetAnchor: "dayOfCreation",
              },
            },
          },
        ],
      })

      expect(result.err).toBeUndefined()
      expect(result.val).toHaveLength(1)
      expect(result.val?.[0]?.resetConfig).toEqual(
        expect.objectContaining({
          name: "daily",
          resetInterval: "day",
          resetAnchor: 15,
        })
      )
    })
  })
})
