import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq } from "@unprice/db"
import { entitlements, grants } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
  type FeatureType,
  type ResetConfig,
  addByInterval,
  type entitlementGrantsSnapshotSchema,
  setUtc,
  setUtcDay,
  startOfUtcDay,
  startOfUtcHour,
} from "@unprice/db/validators"
import type {
  EntitlementMergingPolicy,
  EntitlementState,
  grantSchemaExtended,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type z from "zod"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { UnPriceGrantError } from "./errors"
import type { ConsumptionResult, VerificationResult } from "./types"

interface SubjectGrantQuery {
  subjectId: string
  subjectType: "customer" | "project" | "plan" | "plan_version"
}

export class GrantsManager {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.waitUntil = waitUntil
    this.cache = cache
    this.metrics = metrics
  }

  /**
   * Creates grants with validation to ensure configuration consistency.
   *
   * Validates that all grants for the same feature within overlapping date ranges
   * have the same featureType, resetConfig, and aggregationMethod.
   */
  public async createGrant(params: {
    grant: (typeof grants.$inferInsert)[]
    projectId: string
  }): Promise<Result<(typeof grants.$inferSelect)[], UnPriceGrantError>> {
    const { grant: grantsToCreate, projectId } = params

    if (grantsToCreate.length === 0) {
      return Err(
        new UnPriceGrantError({
          message: "No grants provided",
        })
      )
    }

    // Helper function to check if two date ranges overlap
    const dateRangesOverlap = (
      start1: number,
      end1: number | null,
      start2: number,
      end2: number | null
    ): boolean => {
      const end1Value = end1 ?? Number.POSITIVE_INFINITY
      const end2Value = end2 ?? Number.POSITIVE_INFINITY
      return start1 < end2Value && start2 < end1Value
    }

    // Helper function to compare resetConfig objects
    const resetConfigsEqual = (
      config1: ResetConfig | null,
      config2: ResetConfig | null
    ): boolean => {
      if (config1 === null && config2 === null) return true
      if (config1 === null || config2 === null) return false
      return JSON.stringify(config1) === JSON.stringify(config2)
    }

    // Validate each grant before insertion
    for (const newGrant of grantsToCreate) {
      // Get the featurePlanVersion to access feature configuration
      const featurePlanVersion = await this.db.query.planVersionFeatures.findFirst({
        with: {
          feature: {
            columns: {
              slug: true,
            },
          },
        },
        where: (fpv, { and, eq }) =>
          and(eq(fpv.id, newGrant.featurePlanVersionId), eq(fpv.projectId, projectId)),
      })

      if (!featurePlanVersion) {
        return Err(
          new UnPriceGrantError({
            message: `Feature plan version not found: ${newGrant.featurePlanVersionId}`,
            grantId: newGrant.id,
          })
        )
      }

      const featureSlug = featurePlanVersion.feature.slug
      const newGrantConfig = {
        featureType: featurePlanVersion.featureType,
        resetConfig: featurePlanVersion.resetConfig,
        aggregationMethod: featurePlanVersion.aggregationMethod,
      }

      // Find all existing grants that:
      // 1. Are in the same project
      // 2. Are for the same subject (subjectId + subjectType)
      // 3. Have overlapping date ranges
      // 4. Reference a featurePlanVersion with the same feature slug
      const existingGrants = await this.db.query.grants.findMany({
        with: {
          featurePlanVersion: {
            with: {
              feature: {
                columns: {
                  slug: true,
                },
              },
            },
          },
        },
        where: (grant, { and, eq, not, or, isNull, lt, gt }) =>
          and(
            eq(grant.projectId, projectId),
            eq(grant.subjectId, newGrant.subjectId),
            eq(grant.subjectType, newGrant.subjectType),
            not(eq(grant.deleted, true)),
            // Check for date range overlap:
            // The new grant's effectiveAt must be before existing grant's expiresAt (or null)
            // AND existing grant's effectiveAt must be before new grant's expiresAt (or null)
            or(
              // Case 1: New grant starts before existing grant ends
              and(
                lt(grant.effectiveAt, newGrant.expiresAt ?? Number.MAX_SAFE_INTEGER),
                or(isNull(grant.expiresAt), gt(grant.expiresAt, newGrant.effectiveAt))
              )
            )
          ),
      })

      // Filter to only grants with the same feature slug
      const overlappingGrants = existingGrants.filter(
        (grant) => grant.featurePlanVersion.feature.slug === featureSlug
      )

      // Validate configuration consistency with overlapping grants
      for (const existingGrant of overlappingGrants) {
        const existingFeaturePlanVersion = await this.db.query.planVersionFeatures.findFirst({
          where: (fpv, { and, eq }) =>
            and(eq(fpv.id, existingGrant.featurePlanVersionId), eq(fpv.projectId, projectId)),
        })

        if (!existingFeaturePlanVersion) {
          continue // Skip if feature plan version not found
        }

        const existingGrantConfig = {
          featureType: existingFeaturePlanVersion.featureType,
          resetConfig: existingFeaturePlanVersion.resetConfig,
          aggregationMethod: existingFeaturePlanVersion.aggregationMethod,
        }

        // Verify date ranges actually overlap (double-check)
        const rangesOverlap = dateRangesOverlap(
          newGrant.effectiveAt,
          newGrant.expiresAt ?? null,
          existingGrant.effectiveAt,
          existingGrant.expiresAt ?? null
        )

        if (!rangesOverlap) {
          continue // Skip if ranges don't actually overlap
        }

        // Validate configuration matches
        if (newGrantConfig.featureType !== existingGrantConfig.featureType) {
          return Err(
            new UnPriceGrantError({
              message: `Cannot create grant: featureType mismatch. New grant has featureType "${newGrantConfig.featureType}" but existing grant (${existingGrant.id}) has featureType "${existingGrantConfig.featureType}" for feature "${featureSlug}". All grants for the same feature within overlapping date ranges must have the same featureType.`,
              grantId: newGrant.id,
              subjectId: newGrant.subjectId,
            })
          )
        }

        if (newGrantConfig.aggregationMethod !== existingGrantConfig.aggregationMethod) {
          return Err(
            new UnPriceGrantError({
              message: `Cannot create grant: aggregationMethod mismatch. New grant has aggregationMethod "${newGrantConfig.aggregationMethod}" but existing grant (${existingGrant.id}) has aggregationMethod "${existingGrantConfig.aggregationMethod}" for feature "${featureSlug}". All grants for the same feature within overlapping date ranges must have the same aggregationMethod.`,
              grantId: newGrant.id,
              subjectId: newGrant.subjectId,
            })
          )
        }

        if (!resetConfigsEqual(newGrantConfig.resetConfig, existingGrantConfig.resetConfig)) {
          return Err(
            new UnPriceGrantError({
              message: `Cannot create grant: resetConfig mismatch. New grant and existing grant (${existingGrant.id}) have different resetConfig values for feature "${featureSlug}". All grants for the same feature within overlapping date ranges must have the same resetConfig.`,
              grantId: newGrant.id,
              subjectId: newGrant.subjectId,
            })
          )
        }
      }
    }

    // All validations passed, insert the grants
    try {
      const insertedGrants = await this.db
        .insert(grants)
        .values(
          grantsToCreate.map((grant) => ({
            ...grant,
            projectId,
          }))
        )
        .returning()

      return Ok(insertedGrants)
    } catch (error) {
      this.logger.error("Error creating grants", {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        grantCount: grantsToCreate.length,
      })

      return Err(
        new UnPriceGrantError({
          message: `Failed to create grants: ${error instanceof Error ? error.message : String(error)}`,
        })
      )
    }
  }

  /**
   * Computes all entitlements for a customer by aggregating grants from:
   * - Customer-level grants (subjectSource: "customer")
   * - Project-level grants (subjectSource: "project")
   * - Plan-level grants (subjectSource: "plan") from customer's subscription
   *
   * Creates versioned snapshots that are valid until the next cycle end.
   */
  public async computeEntitlementsForCustomer(params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<(typeof entitlements.$inferSelect)[], FetchError | UnPriceGrantError>> {
    const { customerId, projectId, now } = params

    try {
      // Get customer's subscription to find planId
      const subscription = await this.db.query.subscriptions.findFirst({
        with: {
          phases: {
            where: (phase, { and, lte, or, isNull, gte }) =>
              and(lte(phase.startAt, now), or(isNull(phase.endAt), gte(phase.endAt, now))),
            limit: 1,
            with: {
              planVersion: {
                with: {
                  plan: true,
                },
              },
            },
          },
        },
        where: (sub, { and, eq }) =>
          and(eq(sub.customerId, customerId), eq(sub.projectId, projectId)),
      })

      // TODO: is it need it?
      if (!subscription) {
        return Err(
          new UnPriceGrantError({
            message: "No subscription found for customer",
            subjectId: customerId,
          })
        )
      }

      const planId = subscription?.phases[0]?.planVersion?.plan?.id ?? null
      const planVersionId = subscription?.phases[0]?.planVersion?.id ?? null

      // Build list of subjects to query grants for
      const subjects: SubjectGrantQuery[] = [
        { subjectId: customerId, subjectType: "customer" },
        { subjectId: projectId, subjectType: "project" },
      ]

      if (planId) {
        subjects.push({ subjectId: planId, subjectType: "plan_version" })
      }

      if (planVersionId) {
        subjects.push({ subjectId: planVersionId, subjectType: "plan_version" })
      }

      // Query all active grants for all subjects
      const allGrants = await Promise.all(
        subjects.map((subject) =>
          this.db.query.grants.findMany({
            with: {
              featurePlanVersion: {
                with: {
                  feature: true,
                },
              },
            },
            where: (grant, { and, eq, lte, gt, or, isNull }) =>
              and(
                eq(grant.projectId, projectId),
                eq(grant.subjectId, subject.subjectId),
                eq(grant.subjectType, subject.subjectType),
                lte(grant.effectiveAt, now), // effectiveAt <= now
                or(isNull(grant.expiresAt), gt(grant.expiresAt, now)) // expiresAt > now or null
              ),
            orderBy: (grant, { desc }) => desc(grant.priority),
          })
        )
      )

      // Flatten and group grants by feature slug
      const grantsByFeature = new Map<string, (typeof allGrants)[0]>()

      for (const grantList of allGrants) {
        for (const grant of grantList) {
          const featureSlug = grant.featurePlanVersion.feature.slug
          if (!grantsByFeature.has(featureSlug)) {
            grantsByFeature.set(featureSlug, [])
          }
          grantsByFeature.get(featureSlug)!.push(grant)
        }
      }

      // Normalize order by priority globally per feature (higher first)
      for (const [slug, list] of grantsByFeature) {
        list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        grantsByFeature.set(slug, list)
      }

      // Compute entitlements for each feature
      const computedEntitlements: (typeof entitlements.$inferSelect)[] = []

      for (const [featureSlug, featureGrants] of grantsByFeature.entries()) {
        if (featureGrants.length === 0) continue

        const entitlementResult = await this.computeEntitlementFromGrants({
          grants: featureGrants,
          customerId,
          projectId,
          featureSlug,
          now,
          timezone: subscription?.timezone ?? "UTC",
          cycleEndAt: subscription?.currentCycleEndAt,
        })

        if (entitlementResult.err) {
          this.logger.warn("Failed to compute entitlement for feature", {
            featureSlug,
            error: entitlementResult.err.message,
            customerId,
            projectId,
          })
          continue
        }

        computedEntitlements.push(entitlementResult.val)
      }

      return Ok(computedEntitlements)
    } catch (error) {
      this.logger.error("Error computing entitlements for customer", {
        error: error instanceof Error ? error.message : String(error),
        customerId,
        projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to compute entitlements: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  /**
   * Computes a single entitlement from a list of grants for a feature.
   * This is the core merging logic.
   */
  private async computeEntitlementFromGrants(params: {
    grants: z.infer<typeof grantSchemaExtended>[]
    customerId: string
    projectId: string
    featureSlug: string
    now: number
    timezone: string
    cycleEndAt?: number
  }): Promise<Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>> {
    const {
      grants: featureGrants,
      customerId,
      projectId,
      featureSlug,
      now,
      timezone,
      cycleEndAt,
    } = params

    if (featureGrants.length === 0) {
      return Err(
        new UnPriceGrantError({
          message: `No grants provided for feature ${featureSlug}`,
          subjectId: customerId,
        })
      )
    }

    // Get the best priority grant's feature metadata (all should have same feature)
    // if not they are going to be overridden by the best priority grant
    const bestPriorityGrant = featureGrants.sort((a, b) => b.priority - a.priority)[0]!

    // Determine merging policy from the feature type
    let mergingPolicy: EntitlementMergingPolicy = "sum"

    switch (bestPriorityGrant.featurePlanVersion.featureType) {
      case "flat":
        mergingPolicy = "replace"
        break
      case "tier":
        mergingPolicy = "max"
        break
      case "usage":
        mergingPolicy = "sum"
        break
      case "package":
        mergingPolicy = "max"
        break
      default:
        mergingPolicy = "sum"
        break
    }

    // Sort by priority (higher first) to preserve consumption order
    const ordered = [...featureGrants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

    // Prepare grants snapshot (preserve priority order)
    const grantsSnapshot = ordered.map((g) => ({
      id: g.id,
      type: g.type,
      effectiveAt: g.effectiveAt,
      expiresAt: g.expiresAt,
      limit: g.limit,
      subjectType: g.subjectType,
      subjectId: g.subjectId,
      priority: g.priority,
      realtime: g.featurePlanVersion.metadata?.realtime ?? false,
      hardLimit: g.hardLimit,
      subscriptionItemId: g.subscriptionItem?.id,
      subscriptionPhaseId: g.subscriptionItem?.subscriptionPhaseId,
      subscriptionId: g.subscriptionItem?.subscription?.id,
    }))

    // Merge grants according to merging policy
    const merged = this.mergeGrants({
      grants: grantsSnapshot,
      policy: mergingPolicy,
    })

    // Compute earliest boundary where the answer can change:
    // among the ACTIVE grants we have now, it’s the earliest expiresAt (if any)
    const earliestActiveEnd = ordered
      .map((g) => (g.expiresAt ? Number(g.expiresAt) : Number.POSITIVE_INFINITY))
      .reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY)

    // Derive overall effective/expires for cycle computation
    const effectiveAt = Math.min(...ordered.map((g) => Number(g.effectiveAt)))
    const unionExpires =
      ordered
        .map((g) => (g.expiresAt ? Number(g.expiresAt) : null))
        .filter((e): e is number => e !== null)
        .reduce((max, e) => Math.max(max, e), 0) || null

    // Compute cycle window from reset config (half-open style via bounds)
    const resetConfig = bestPriorityGrant.featurePlanVersion.resetConfig
    const cycleBoundaries = this.computeCycleBoundaries({
      now,
      resetConfig,
      timezone,
      effectiveAt,
      expiresAt: cycleEndAt ?? unionExpires ?? null,
    })

    // Choose the earliest time we should revalidate next (don’t requery future starts here)
    const nextBoundary = Math.min(
      cycleBoundaries.end ?? Number.POSITIVE_INFINITY,
      earliestActiveEnd
    )
    const resolvedExpiresAt = Number.isFinite(nextBoundary)
      ? nextBoundary
      : (cycleEndAt ?? unionExpires ?? null)

    // Check if entitlement already exists (using customer as subject for the snapshot)
    const existingEntitlement = await this.db.query.entitlements.findFirst({
      where: (entitlement, { and, eq }) =>
        and(
          eq(entitlement.projectId, projectId),
          eq(entitlement.customerId, customerId),
          eq(entitlement.featureSlug, featureSlug)
        ),
    })

    const entitlementData = {
      projectId,
      customerId,
      featureSlug,
      featureType: bestPriorityGrant.featurePlanVersion.featureType as FeatureType,
      limit: merged.limit,
      hardLimit: merged.hardLimit,
      aggregationMethod: bestPriorityGrant.featurePlanVersion.aggregationMethod,
      resetConfig,
      timezone,
      mergingPolicy,
      grants: grantsSnapshot,
      version: existingEntitlement ? existingEntitlement.version + 1 : 0,
      computedAt: now,
      effectiveAt,
      expiresAt: resolvedExpiresAt,
      // Preserve existing usage if updating
      currentCycleUsage: existingEntitlement?.currentCycleUsage ?? "0",
      accumulatedUsage: existingEntitlement?.accumulatedUsage ?? "0",
      lastSyncAt: existingEntitlement?.lastSyncAt ?? now,
      nextRevalidateAt: nextBoundary,
    }

    let result: typeof entitlements.$inferSelect

    if (existingEntitlement) {
      // Update existing entitlement
      const updated = await this.db
        .update(entitlements)
        .set({
          ...entitlementData,
          version: existingEntitlement.version + 1,
          computedAt: now,
          effectiveAt,
          expiresAt: resolvedExpiresAt,
          lastSyncAt: now,
          updatedAtM: now,
        })
        .where(
          and(eq(entitlements.id, existingEntitlement.id), eq(entitlements.projectId, projectId))
        )
        .returning()
        .catch((error) => {
          this.logger.error("Error updating entitlement", {
            error: error instanceof Error ? error.message : String(error),
            entitlementId: existingEntitlement.id,
            projectId,
          })

          throw error
        })
        .then((rows) => rows[0])

      if (!updated) {
        return Err(
          new FetchError({
            message: "Failed to update entitlement",
            retry: true,
          })
        )
      }

      result = updated
    } else {
      // Create new entitlement
      const created = await this.db
        .insert(entitlements)
        .values({
          id: newId("entitlement"),
          ...entitlementData,
        })
        .returning()
        .then((rows) => rows[0])
        .catch((error) => {
          this.logger.error("Error creating entitlement", {
            error: error instanceof Error ? error.message : String(error),
            projectId,
          })
          throw error
        })

      if (!created) {
        return Err(
          new FetchError({
            message: "Failed to create entitlement",
            retry: true,
          })
        )
      }

      result = created
    }

    return Ok(result)
  }

  /**
   * Invalidates entitlements affected by grant changes.
   * Marks entitlements for recomputation by incrementing grantVersion.
   * TODO: implement this
   */
  public async invalidateEntitlements(grantIds: string[]): Promise<
    Result<
      {
        invalidatedCount: number
      },
      FetchError
    >
  > {
    try {
      // Find all entitlements that reference these grants
      const affectedGrants = await this.db.query.grants.findMany({
        where: (grant, { and, inArray }) => and(inArray(grant.id, grantIds)),
        columns: {
          projectId: true,
          subjectId: true,
          subjectType: true,
          id: true,
        },
        with: {
          featurePlanVersion: {
            with: {
              feature: {
                columns: {
                  slug: true,
                },
              },
            },
          },
        },
      })

      if (affectedGrants.length === 0) {
        return Ok({ invalidatedCount: 0 })
      }

      // Update grantVersion to trigger recomputation
      const now = Date.now()
      const updatePromises = affectedGrants.map((grant) =>
        this.db
          .update(grants)
          .set({
            updatedAtM: now,
          })
          .where(and(eq(grants.id, grant.id), eq(grants.projectId, grant.projectId)))
      )

      await Promise.all(updatePromises)

      // Find affected entitlements and mark for recomputation
      const affectedEntitlements = await Promise.all(
        affectedGrants.map((grant) =>
          this.db.query.entitlements.findFirst({
            where: (entitlement, { and, eq }) =>
              and(
                eq(entitlement.projectId, grant.projectId),
                eq(entitlement.customerId, grant.subjectId),
                eq(entitlement.featureSlug, grant.featurePlanVersion.feature.slug)
              ),
          })
        )
      )

      const validEntitlements = affectedEntitlements.filter(
        (e): e is NonNullable<typeof e> => e !== null && e !== undefined
      )

      if (validEntitlements.length > 0) {
        // TODO: Invalidate cache for these entitlements
        // Note: Cache invalidation will be handled by the cache service
        // This is just marking entitlements as needing recomputation
      }

      return Ok({ invalidatedCount: validEntitlements.length })
    } catch (error) {
      this.logger.error("Error invalidating entitlements", {
        error: error instanceof Error ? error.message : String(error),
        grantIds,
      })

      return Err(
        new FetchError({
          message: `Failed to invalidate entitlements: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  /**
   * Merges grants according to the specified merging policy.
   */
  private mergeGrants(params: {
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    policy: EntitlementMergingPolicy
  }): {
    limit: number | null
    hardLimit: boolean
  } {
    const { grants, policy } = params

    if (grants.length === 0) {
      return { limit: null, hardLimit: false }
    }

    // Sort by priority (higher priority first)
    const sorted = [...grants].sort((a, b) => b.priority - a.priority)

    switch (policy) {
      case "sum": {
        const limit = sorted.reduce((sum, g) => sum + (g.limit ?? 0), 0)
        // Hard limit is true if ANY grant has hard limit
        const hardLimit = sorted.some((g) => g.hardLimit)
        return {
          limit: limit > 0 ? limit : null,
          hardLimit,
        }
      }

      case "max": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)
        const hardLimit = sorted.some((g) => g.hardLimit)
        return {
          limit: limits.length > 0 ? Math.max(...limits) : null,
          hardLimit,
        }
      }

      case "min": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)
        const hardLimit = sorted.every((g) => g.hardLimit)
        return {
          limit: limits.length > 0 ? Math.min(...limits) : null,
          hardLimit,
        }
      }

      case "replace": {
        // Highest priority grant replaces all others
        const highest = sorted[0]!
        return {
          limit: highest.limit,
          hardLimit: highest.hardLimit,
        }
      }

      default: {
        // Fallback to replace
        const highestD = sorted[0]!
        return {
          limit: highestD.limit ?? null,
          hardLimit: !!highestD.hardLimit,
        }
      }
    }
  }

  /**
   * Computes cycle boundaries from reset config, similar to billing cycle calculation.
   */
  private computeCycleBoundaries(params: {
    now: number
    resetConfig: ResetConfig | null
    timezone: string
    effectiveAt: number
    expiresAt: number | null
  }): {
    start: number
    end: number | null
  } {
    const { now, resetConfig, effectiveAt, expiresAt } = params

    // If no reset config, use grant effective/expires boundaries
    if (!resetConfig) {
      return {
        start: effectiveAt,
        end: expiresAt,
      }
    }

    // Similar logic to calculateCycleWindow but for reset intervals
    const { resetInterval, resetIntervalCount, resetAnchor } = resetConfig

    // Calculate anchor date
    const effectiveDate = new Date(effectiveAt)
    let anchorDate: Date

    switch (resetInterval) {
      case "minute": {
        const c = Math.max(1, resetIntervalCount)
        const y = effectiveDate.getUTCFullYear()
        const m = effectiveDate.getUTCMonth()
        const d = effectiveDate.getUTCDate()
        const h = effectiveDate.getUTCHours()
        const minute = effectiveDate.getUTCMinutes()
        const alignedMinute = minute - (minute % c)
        const anchorValue = typeof resetAnchor === "number" ? resetAnchor : 0
        anchorDate = new Date(Date.UTC(y, m, d, h, alignedMinute, anchorValue, 0))
        break
      }
      case "day": {
        const anchorValue = typeof resetAnchor === "number" ? resetAnchor : 0
        anchorDate = startOfUtcHour(setUtc(effectiveDate, { hours: anchorValue }))
        break
      }
      case "week": {
        const anchorValue = typeof resetAnchor === "number" ? resetAnchor : 0
        anchorDate = startOfUtcDay(setUtcDay(effectiveDate, anchorValue, 0))
        break
      }
      case "month":
      case "year": {
        const anchorValue = typeof resetAnchor === "number" ? resetAnchor : 1
        anchorDate = startOfUtcDay(setUtc(effectiveDate, { date: anchorValue }))
        break
      }
      default:
        return { start: effectiveAt, end: expiresAt }
    }

    // Ensure anchor is not before effective date
    if (anchorDate.getTime() < effectiveAt) {
      anchorDate = addByInterval(anchorDate, resetInterval, resetIntervalCount)
    }

    // Find current cycle
    let cycleStart = anchorDate
    let cycleEnd = addByInterval(cycleStart, resetInterval, resetIntervalCount)

    // If now is before first anchor, use stub period
    if (now < cycleStart.getTime()) {
      return {
        start: effectiveAt,
        end: Math.min(cycleStart.getTime(), expiresAt ?? Number.POSITIVE_INFINITY),
      }
    }

    // Find the cycle containing 'now'
    while (now >= cycleEnd.getTime()) {
      cycleStart = cycleEnd
      cycleEnd = addByInterval(cycleStart, resetInterval, resetIntervalCount)
    }

    const start = cycleStart.getTime()
    const end = Math.min(cycleEnd.getTime(), expiresAt ?? Number.POSITIVE_INFINITY)

    return { start, end: expiresAt ? end : null }
  }

  /**
   * Check if usage is allowed and give the information of the grants that were used to calculate the result
   */
  public verify(params: { state: EntitlementState; now: number }): VerificationResult {
    const { state, now } = params
    const { err, val: validatedState } = this.validateEntitlementAccess({
      state,
      now,
    })

    if (err) {
      return {
        allowed: false,
        message: err.message,
        deniedReason: "ENTITLEMENT_ERROR",
        usage: 0,
        limit: null,
      }
    }

    // Flat features always allowed
    if (validatedState.featureType === "flat") {
      return {
        allowed: true,
        message: "Flat feature",
        usage: 1,
        limit: 1,
      }
    }

    // Check limit
    const hasLimit = validatedState.limit !== null
    const withinLimit =
      !hasLimit ||
      Number(validatedState.currentCycleUsage) < (validatedState.limit ?? Number.POSITIVE_INFINITY)

    return {
      allowed: withinLimit,
      message: withinLimit ? "Allowed" : "Limit exceeded",
      deniedReason: withinLimit ? undefined : "LIMIT_EXCEEDED",
      usage: Number(validatedState.currentCycleUsage),
      limit: validatedState.limit,
    }
  }

  /**
   * Consume usage from grants by priority
   * Returns which grants were consumed for billing attribution
   */
  public consume(params: {
    state: EntitlementState
    amount: number
    now: number
  }): ConsumptionResult {
    const { state, amount, now } = params

    // 1. Get active grants at this timestamp
    const { err, val: validatedState } = this.validateEntitlementAccess({
      state,
      now,
    })

    if (err) {
      return {
        success: false,
        usage: 0,
        limit: null,
        consumedFrom: [],
        message: err.message,
      }
    }

    const activeGrants = validatedState.grants

    // 2. Recalculate effective limit from active grants (in case grants expired)
    const { limit: effectiveLimit, hardLimit } = this.mergeGrants({
      grants: activeGrants,
      policy: validatedState.mergingPolicy,
    })

    // 3. Check unified limit (no per-grant tracking needed)
    const newUsage = Number(state.currentCycleUsage) + amount
    const withinLimit = effectiveLimit === null || newUsage <= effectiveLimit

    // 4. Determine which grants would be consumed for billing attribution
    const consumedFrom = this.attributeConsumption(activeGrants, amount)

    const success = withinLimit || !hardLimit

    return {
      success,
      usage: newUsage,
      limit: effectiveLimit,
      consumedFrom,
      message: success ? "Allowed" : "Limit exceeded",
    }
  }

  /**
   * Determine which grants would be consumed for billing attribution
   */
  private attributeConsumption(
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[],
    amount: number
  ): Array<{ grantId: string; amount: number; priority: number; type: string }> {
    // Sort by priority
    const sorted = [...grants].sort((a, b) => b.priority - a.priority)

    // Attribute consumption by priority (for billing records)
    // This is just for attribution, not for limit checking
    const attribution: Array<{ grantId: string; amount: number; priority: number; type: string }> =
      []
    let remaining = amount

    for (const grant of sorted) {
      if (remaining <= 0) break

      // For attribution, we can use grant.limit as a guide
      // but we don't need to track consumed per-grant
      const toAttribute = grant.limit === null ? remaining : Math.min(remaining, grant.limit)

      attribution.push({
        grantId: grant.id,
        amount: toAttribute,
        priority: grant.priority,
        type: grant.type,
      })

      remaining -= toAttribute
    }

    return attribution
  }

  /**
   * Checks if a timestamp falls within any active grant period
   */
  private isGrantActiveAtTimestamp(params: {
    grant: z.infer<typeof entitlementGrantsSnapshotSchema>
    now: number
  }): boolean {
    const { grant, now } = params
    const grantStart = grant.effectiveAt
    const grantEnd = grant.expiresAt ?? Number.POSITIVE_INFINITY
    return now >= grantStart && now < grantEnd
  }

  /**
   * Gets the active grant(s) at a specific timestamp
   */
  private getActiveGrantsAtTimestamp(params: {
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    now: number
  }): z.infer<typeof entitlementGrantsSnapshotSchema>[] {
    const { grants, now } = params

    // sort by priority
    return grants
      .filter((grant) => this.isGrantActiveAtTimestamp({ grant, now }))
      .sort((a, b) => b.priority - a.priority)
  }

  /**
   * Validates entitlement access at a specific timestamp
   */
  private validateEntitlementAccess(params: { state: EntitlementState; now: number }): Result<
    EntitlementState,
    UnPriceGrantError
  > {
    const { state, now } = params

    // First check if timestamp is within overall entitlement range
    if (now < state.effectiveAt) {
      return Err(
        new UnPriceGrantError({
          message: "Entitlement not yet effective",
          subjectId: state.customerId,
        })
      )
    }

    if (state.expiresAt && now >= state.expiresAt) {
      return Err(
        new UnPriceGrantError({
          message: "Entitlement expired",
          subjectId: state.customerId,
        })
      )
    }

    // Then check if any grant is active at this timestamp
    const activeGrants = this.getActiveGrantsAtTimestamp({ grants: state.grants, now })

    if (activeGrants.length === 0) {
      return Err(
        new UnPriceGrantError({
          message: "No active grant at this timestamp",
          subjectId: state.customerId,
        })
      )
    }

    return Ok({
      ...state,
      grants: activeGrants,
    })
  }
}
