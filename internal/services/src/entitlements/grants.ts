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
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type z from "zod"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { UnPriceGrantError } from "./errors"
import type { ConsumptionResult, EntitlementState, VerificationResult } from "./types"

type MergingPolicy = "sum" | "max" | "min" | "replace"

interface ComputeEntitlementsForCustomerParams {
  customerId: string
  projectId: string
  now: number
}

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

  // TODO: create a method to insert grants for a customer

  /**
   * Computes all entitlements for a customer by aggregating grants from:
   * - Customer-level grants (subjectSource: "customer")
   * - Project-level grants (subjectSource: "project")
   * - Plan-level grants (subjectSource: "plan") from customer's subscription
   *
   * Creates versioned snapshots that are valid until the next cycle end.
   */
  public async computeEntitlementsForCustomer(
    params: ComputeEntitlementsForCustomerParams
  ): Promise<Result<(typeof entitlements.$inferSelect)[], FetchError | UnPriceGrantError>> {
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
          grants: featureGrants as unknown as z.infer<typeof entitlementGrantsSnapshotSchema>[],
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
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
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

    // Get the first grant's feature metadata (all should have same feature)
    const firstGrant = featureGrants[0]!
    const featurePlanVersion = firstGrant.featurePlanVersion

    // Determine merging policy from the feature type
    let mergingPolicy: MergingPolicy = "sum"

    switch (featurePlanVersion.featureType) {
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

    // Merge grants according to merging policy
    const merged = this.mergeGrants(ordered, mergingPolicy)

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
    const resetConfig = featurePlanVersion.resetConfig
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

    // Prepare grants snapshot (preserve priority order)
    const grantsSnapshot = ordered.map((grant) => ({
      id: grant.id,
      featurePlanVersion: {
        id: featurePlanVersion.id,
        planVersionId: featurePlanVersion.planVersionId,
        featureType: featurePlanVersion.featureType,
        resetConfig: featurePlanVersion.resetConfig,
      },
      type: grant.type,
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      priority: grant.priority,
      effectiveAt: Number(grant.effectiveAt),
      expiresAt: grant.expiresAt ? Number(grant.expiresAt) : Number.POSITIVE_INFINITY,
      limit: grant.limit,
      units: grant.units,
      hardLimit: grant.hardLimit,
    }))

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
      featureType: featurePlanVersion.featureType as FeatureType,
      effectiveLimit: merged.limit,
      effectiveUnits: merged.units,
      effectiveHardLimit: merged.hardLimit,
      effectiveResetConfig: resetConfig,
      timezone,
      cycleStartAt: cycleBoundaries.start,
      cycleEndAt: Number.isFinite(nextBoundary)
        ? nextBoundary
        : (cycleEndAt ?? cycleBoundaries.end ?? null),
      lastResetAt: cycleBoundaries.start,
      mergingPolicy,
      grants: grantsSnapshot,
      version: existingEntitlement ? existingEntitlement.version + 1 : 0,
      computedAt: now,
      effectiveAt,
      expiresAt: resolvedExpiresAt,
      // Preserve existing usage if updating
      currentCycleUsage: existingEntitlement?.currentCycleUsage ?? "0",
      accumulatedUsage: existingEntitlement?.accumulatedUsage ?? "0",
      lastUsageUpdateAt: existingEntitlement?.lastUsageUpdateAt ?? now,
      nextRevalidateAt: resolvedExpiresAt ?? cycleEndAt ?? cycleBoundaries.end!,
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
          lastUsageUpdateAt: now,
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
  private mergeGrants(
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[],
    policy: MergingPolicy
  ): {
    limit: number | null
    units: number | null
    hardLimit: boolean
  } {
    if (grants.length === 0) {
      return { limit: null, units: null, hardLimit: false }
    }

    // Sort by priority (higher priority first)
    const sorted = [...grants].sort((a, b) => b.priority - a.priority)

    switch (policy) {
      case "sum": {
        const limit = sorted.reduce((sum, g) => sum + (g.limit ?? 0), 0)
        const units = sorted.reduce((sum, g) => sum + (g.units ?? 0), 0)
        // Hard limit is true if ANY grant has hard limit
        const hardLimit = sorted.some((g) => g.hardLimit)
        return {
          limit: limit > 0 ? limit : null,
          units: units > 0 ? units : null,
          hardLimit,
        }
      }

      case "max": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)
        const units = sorted.map((g) => g.units).filter((u): u is number => u !== null)
        const hardLimit = sorted.some((g) => g.hardLimit)
        return {
          limit: limits.length > 0 ? Math.max(...limits) : null,
          units: units.length > 0 ? Math.max(...units) : null,
          hardLimit,
        }
      }

      case "min": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)
        const units = sorted.map((g) => g.units).filter((u): u is number => u !== null)
        const hardLimit = sorted.every((g) => g.hardLimit)
        return {
          limit: limits.length > 0 ? Math.min(...limits) : null,
          units: units.length > 0 ? Math.min(...units) : null,
          hardLimit,
        }
      }

      case "replace": {
        // Highest priority grant replaces all others
        const highest = sorted[0]!
        return {
          limit: highest.limit,
          units: highest.units,
          hardLimit: highest.hardLimit,
        }
      }

      default: {
        // Fallback to replace
        const highestD = sorted[0]!
        return {
          limit: highestD.limit ?? null,
          units: highestD.units ?? null,
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
   * Check if usage is allowed
   */
  verify(state: EntitlementState): VerificationResult {
    // Flat features always allowed
    if (state.featureType === "flat") {
      return {
        allowed: true,
        message: "Flat feature",
        usage: 1,
        limit: 1,
      }
    }

    // Check limit
    const hasLimit = state.limit !== null
    const withinLimit = !hasLimit || state.currentUsage < (state.limit ?? Number.POSITIVE_INFINITY)

    return {
      allowed: withinLimit,
      message: withinLimit ? "Allowed" : "Limit exceeded",
      usage: state.currentUsage,
      limit: state.limit,
    }
  }

  /**
   * Consume usage from grants by priority
   * Returns which grants were consumed for billing attribution
   */
  consume(state: EntitlementState, amount: number): ConsumptionResult {
    // Flat features don't consume
    if (state.featureType === "flat") {
      return {
        success: false,
        message: "Cannot report usage for flat features",
        usage: state.currentUsage,
        limit: state.limit,
        consumedFrom: [],
      }
    }

    // Sort grants by priority (highest first)
    const sortedGrants = [...state.grants].sort((a, b) => b.priority - a.priority)

    // Consume from each grant
    const consumedFrom: ConsumptionResult["consumedFrom"] = []
    let remaining = amount

    for (const grant of sortedGrants) {
      if (remaining <= 0) break

      const available =
        grant.limit === null
          ? remaining // unlimited
          : Math.max(0, grant.limit - grant.consumed)

      if (available <= 0) continue

      const toConsume = Math.min(available, remaining)

      consumedFrom.push({
        grantId: grant.id,
        amount: toConsume,
        priority: grant.priority,
        type: grant.type,
      })

      grant.consumed += toConsume
      remaining -= toConsume
    }

    const newUsage = state.currentUsage + (amount - remaining)
    const withinLimit = state.limit === null || newUsage <= state.limit

    return {
      success: remaining === 0 || withinLimit,
      message: remaining === 0 ? "Consumed" : "Insufficient capacity",
      usage: newUsage,
      limit: state.limit,
      consumedFrom,
    }
  }
}
