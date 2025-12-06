import { type Database, and, eq, inArray } from "@unprice/db"
import { entitlements, grants } from "@unprice/db/schema"
import { type UsageMode, hashStringSHA256, newId } from "@unprice/db/utils"
import {
  type FeatureType,
  calculateCycleWindow,
  type entitlementGrantsSnapshotSchema,
} from "@unprice/db/validators"
import type {
  AggregationMethod,
  EntitlementMergingPolicy,
  EntitlementState,
  ReportUsageResult,
  VerificationResult,
  grantInsertSchema,
  grantSchema,
  grantSchemaExtended,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type z from "zod"
import { UnPriceGrantError } from "./errors"

interface SubjectGrantQuery {
  subjectId: string
  subjectType: "customer" | "project" | "plan" | "plan_version"
}

export class GrantsManager {
  private readonly db: Database
  private readonly logger: Logger
  private readonly revalidateInterval: number

  constructor({
    db,
    logger,
    revalidateInterval,
  }: {
    db: Database
    logger: Logger
    revalidateInterval?: number
  }) {
    this.db = db
    this.logger = logger
    this.revalidateInterval = revalidateInterval ?? 300000 // 5 minutes default
  }

  public async deleteGrants(params: {
    grantIds: string[]
    projectId: string
    subjectType: "customer" | "project" | "plan" | "plan_version"
    subjectId: string
  }): Promise<Result<void, FetchError | UnPriceGrantError>> {
    const { grantIds, projectId, subjectType, subjectId } = params

    await this.db
      .update(grants)
      .set({ deleted: true, updatedAtM: Date.now(), deletedAt: Date.now() })
      .where(
        and(
          inArray(grants.id, grantIds),
          eq(grants.projectId, projectId),
          eq(grants.subjectType, subjectType),
          eq(grants.subjectId, subjectId),
          eq(grants.deleted, false)
        )
      )

    return Ok(undefined)
  }

  public async getGrantsForCustomer(params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<z.infer<typeof grantSchemaExtended>[], FetchError | UnPriceGrantError>> {
    const { customerId, projectId, now } = params

    // get all grants for a project and customer
    // get the customer's subscription to find planId
    const customerSubscription = await this.db.query.customers.findFirst({
      with: {
        subscriptions: {
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
        },
      },
      where: (customer, { and, eq }) =>
        and(eq(customer.id, customerId), eq(customer.projectId, projectId)),
    })

    if (!customerSubscription) {
      return Err(
        new UnPriceGrantError({
          message: "No customer found for project",
          subjectId: customerId,
        })
      )
    }

    const subscription = customerSubscription?.subscriptions[0] ?? null
    const currentPhase = subscription?.phases[0] ?? null
    const planId = currentPhase?.planVersion?.plan?.id ?? null
    const planVersionId = currentPhase?.planVersion?.id ?? null

    // Build list of subjects to query grants for
    const subjects: SubjectGrantQuery[] = [
      { subjectId: customerId, subjectType: "customer" },
      { subjectId: projectId, subjectType: "project" },
    ]

    if (planId) {
      subjects.push({ subjectId: planId, subjectType: "plan" })
    }

    if (planVersionId) {
      subjects.push({ subjectId: planVersionId, subjectType: "plan_version" })
    }

    // Query all active grants for all subjects in the period of the current cycle
    try {
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
            where: (grant, { and, eq, gte, lte, or, isNull }) =>
              and(
                eq(grant.projectId, projectId),
                eq(grant.subjectId, subject.subjectId),
                eq(grant.subjectType, subject.subjectType),
                eq(grant.deleted, false),
                // Grant is effective: effectiveAt <= now
                lte(grant.effectiveAt, now),
                // Grant hasn't expired: expiresAt is null OR expiresAt >= now
                or(isNull(grant.expiresAt), gte(grant.expiresAt, now))
              ),
            orderBy: (grant, { desc }) => desc(grant.priority),
          })
        )
      )

      return Ok(allGrants.flat())
    } catch (error) {
      this.logger.error("Error getting grants for customer", {
        error: error instanceof Error ? error.message : String(error),
        customerId,
        projectId,
      })
      return Err(
        new FetchError({
          message: `Failed to get grants for customer: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  /**
   * Creates grants with validation to ensure configuration consistency.
   * Grants are append only, so if new grants are created that are already present, we need to delete the old ones
   * Grants are duplicated if they shared the same subjectId, subjectType, featurePlanVersionId, and effectiveAt and expiresAt
   * Grants with different subjectId and subsjecttype are not duplicated and we need to check for configuration consistency with overlapping grants
   * @param params - The parameters for creating grants
   * @param params.grants - The grants to create
   * @returns The result of creating grants
   * @throws UnPriceGrantError if the grants cannot be created
   * @throws FetchError if the grants cannot be created
   */
  public async createGrant(params: {
    grant: z.infer<typeof grantInsertSchema>
  }): Promise<Result<z.infer<typeof grantSchema>, UnPriceGrantError>> {
    const { grant: newGrant } = params

    // priority map for the grants types
    const priorityMap = {
      subscription: 10,
      addon: 20,
      trial: 60,
      promotion: 70,
      manual: 80,
    } as const

    // We don't care which grant is inserted, we just want to make sure it's unique
    // the merging logic will handle the rest
    try {
      const insertedGrants = await this.db
        .insert(grants)
        .values({
          ...newGrant,
          priority: priorityMap[newGrant.type],
        })
        .onConflictDoNothing({
          target: [
            grants.projectId,
            grants.subjectId,
            grants.subjectType,
            grants.type,
            grants.effectiveAt,
            grants.expiresAt,
            grants.featurePlanVersionId,
          ],
        })
        .returning()
        .catch((error) => {
          this.logger.error("Error creating grants", {
            error: error instanceof Error ? error.message : String(error),
            grantId: newGrant.id,
          })

          throw error
        })
        .then((rows) => rows[0])

      if (!insertedGrants) {
        return Err(
          new UnPriceGrantError({
            message: `Failed to create grant: ${newGrant.id}`,
            grantId: newGrant.id,
            subjectId: newGrant.subjectId,
          })
        )
      }

      return Ok(insertedGrants)
    } catch (error) {
      this.logger.error("Error creating grants", {
        error: error instanceof Error ? error.message : String(error),
        grantId: newGrant.id,
      })

      return Err(
        new UnPriceGrantError({
          message: `Failed to create grants: ${error instanceof Error ? error.message : String(error)}`,
        })
      )
    }
  }

  public async renewGrantsForCustomer(params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<(typeof grants.$inferSelect)[], FetchError | UnPriceGrantError>> {
    const { customerId, projectId, now } = params

    const { val: allGrants, err: getGrantsErr } = await this.getGrantsForCustomer({
      customerId,
      projectId,
      now,
    })

    if (getGrantsErr) {
      return Err(getGrantsErr)
    }

    // only renew grants with auto renew true and not trial and subscription
    const autoRenewGrants = allGrants.filter(
      (grant) => grant.autoRenew && grant.type !== "trial" && grant.type !== "subscription"
    )

    const renewedGrants = []
    for (const grant of autoRenewGrants) {
      const cycle = calculateCycleWindow({
        now: now,
        effectiveStartDate: grant.effectiveAt,
        effectiveEndDate: grant.expiresAt ?? null,
        config: {
          name: grant.featurePlanVersion.billingConfig.name,
          interval: grant.featurePlanVersion.billingConfig.billingInterval,
          intervalCount: grant.featurePlanVersion.billingConfig.billingIntervalCount,
          anchor: grant.anchor,
          planType: grant.featurePlanVersion.billingConfig.planType,
        },
        trialEndsAt: null,
      })

      if (!cycle) {
        return Err(
          new UnPriceGrantError({
            message: "Failed to calculate cycle window",
            subjectId: grant.subjectId,
          })
        )
      }

      // create the grant
      const createGrantResult = await this.createGrant({
        grant: {
          ...grant,
          effectiveAt: cycle.start,
          expiresAt: cycle.end,
        },
      })

      if (createGrantResult.err) {
        this.logger.error("Failed to renew grant", {
          error: createGrantResult.err.message,
          grantId: grant.id,
          subjectId: grant.subjectId,
        })
        continue
      }

      renewedGrants.push(createGrantResult.val)
    }

    return Ok(renewedGrants)
  }

  /**
   * Computes all entitlements for a customer by aggregating grants from:
   * - Customer-level grants (subjectSource: "customer")
   * - Project-level grants (subjectSource: "project")
   * - Plan-level grants (subjectSource: "plan") from customer's subscription
   *
   * Creates versioned snapshots that are valid until the next cycle end.
   * @param customerId - Customer id to compute the entitlements for
   * @param projectId - Project id to compute the entitlements for
   * @param now - Current time to compute the entitlements for
   * @returns Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>
   * @throws UnPriceGrantError if the entitlements cannot be computed
   * @throws FetchError if the entitlements cannot be computed
   */
  public async computeGrantsForCustomer({
    customerId,
    projectId,
    now,
    usageOverrides,
    featureSlug,
  }: {
    customerId: string
    projectId: string
    now: number
    usageOverrides?: Record<string, { currentCycleUsage: string; accumulatedUsage: string }>
    featureSlug?: string
  }): Promise<Result<EntitlementState[], FetchError | UnPriceGrantError>> {
    try {
      const { val: allGrants, err: getGrantsErr } = await this.getGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      if (getGrantsErr) {
        return Err(getGrantsErr)
      }

      // Group grants by feature slug
      const grantsByFeature = new Map<string, typeof allGrants>()

      for (const grant of allGrants) {
        const grantFeatureSlug = grant.featurePlanVersion.feature.slug

        // Optimization: skip if we are looking for a specific feature
        if (featureSlug && grantFeatureSlug !== featureSlug) {
          continue
        }

        if (!grantsByFeature.has(grantFeatureSlug)) {
          grantsByFeature.set(grantFeatureSlug, [])
        }

        // add the grant to the list of grants for the feature
        grantsByFeature.get(grantFeatureSlug)!.push(grant)
      }

      // Normalize order by priority globally per feature (higher first)
      for (const [slug, list] of grantsByFeature) {
        list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        grantsByFeature.set(slug, list)
      }

      // Compute entitlements for each feature
      const computedEntitlements: (typeof entitlements.$inferSelect)[] = []

      for (const [featureSlugItem, featureGrants] of grantsByFeature.entries()) {
        if (featureGrants.length === 0) continue

        // optimization
        if (featureSlug && featureSlug !== featureSlugItem) {
          continue
        }

        // compute the entitlement for each feature in the current cycle
        // this is idempotent, so if the entitlement already exists, it will be updated
        const entitlementResult = await this.computeEntitlementFromGrants({
          grants: featureGrants,
          customerId,
          projectId,
          now,
          usageOverride: usageOverrides?.[featureSlugItem],
        })

        if (entitlementResult.err) {
          this.logger.error("Failed to compute entitlement for feature", {
            featureSlug: featureSlugItem,
            error: entitlementResult.err.message,
            customerId,
            projectId,
          })

          return Err(entitlementResult.err)
        }

        computedEntitlements.push(entitlementResult.val)
      }

      return Ok(computedEntitlements as EntitlementState[])
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
   * Computes the entitlement state from a list of grants without saving to the database.
   * This logic is shared between the entitlement computation and the billing estimation.
   */
  public computeEntitlementState(params: {
    grants: z.infer<typeof grantSchemaExtended>[]
  }): Result<
    {
      limit: number | null
      allowOverage: boolean
      mergingPolicy: EntitlementMergingPolicy
      activeGrants: z.infer<typeof grantSchemaExtended>[]
      winningGrant: z.infer<typeof grantSchemaExtended>
      effectiveAt: number
      expiresAt: number | null
      resetConfig: EntitlementState["resetConfig"] | null
      featureType: FeatureType
      aggregationMethod: AggregationMethod
      grantsSnapshot: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    },
    UnPriceGrantError
  > {
    const { grants } = params

    if (grants.length === 0) {
      return Err(new UnPriceGrantError({ message: "No grants provided" }))
    }

    // Sort by priority (higher first) to preserve consumption order and get the best priority grant
    // This determines the "intent" (feature type) of the entitlement configuration
    const ordered = [...grants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    const bestPriorityGrant = ordered[0]!

    // Prepare grants snapshot (preserve priority order)
    const grantsSnapshot = ordered.map((g) => ({
      id: g.id,
      type: g.type,
      name: g.name,
      effectiveAt: g.effectiveAt,
      expiresAt: g.expiresAt,
      limit: g.limit,
      subjectType: g.subjectType,
      subjectId: g.subjectId,
      priority: g.priority,
      realtime: g.featurePlanVersion.metadata?.realtime ?? false,
      allowOverage: g.allowOverage,
      featurePlanVersionId: g.featurePlanVersionId,
      subscriptionItemId: g.subscriptionItem?.id ?? null,
      subscriptionPhaseId: g.subscriptionItem?.subscriptionPhaseId ?? null,
      subscriptionId: g.subscriptionItem?.subscription?.id ?? null,
    }))

    // Merge grants according to merging policy derived from feature type
    const merged = this.mergeGrants({
      grants: grantsSnapshot,
      featureType: bestPriorityGrant.featurePlanVersion.featureType,
      usageMode: bestPriorityGrant.featurePlanVersion.config.usageMode,
    })

    // The effective configuration should come from the "winning" grant(s)
    // If merged.grants is empty (shouldn't happen if grants.length > 0), fall back to bestPriorityGrant
    // But since we filter grants in mergeGrants, we need to find the corresponding full grant object
    // for the winning grant ID to get full configuration (resetConfig etc).

    const winningGrantSnapshot = merged.grants[0] ?? grantsSnapshot[0]!
    const winningGrant = grants.find((g) => g.id === winningGrantSnapshot.id) ?? bestPriorityGrant

    // Derive overall effective/expires for cycle computation
    // Compute cycle window from reset config (half-open style via bounds)
    // Use the winning grant's reset config
    const resetConfig = winningGrant.featurePlanVersion.resetConfig
      ? {
          ...winningGrant.featurePlanVersion.resetConfig,
          resetAnchor: winningGrant.anchor,
        }
      : null

    // use the winning grant's billing config
    const billingConfig = winningGrant.featurePlanVersion.billingConfig
      ? {
          name: winningGrant.featurePlanVersion.billingConfig.name,
          resetInterval: winningGrant.featurePlanVersion.billingConfig.billingInterval,
          resetIntervalCount: winningGrant.featurePlanVersion.billingConfig.billingIntervalCount,
          planType: winningGrant.featurePlanVersion.billingConfig.planType,
          resetAnchor: winningGrant.anchor,
        }
      : null

    // Map snapshots back to original grants for the active grants list
    const activeGrants = merged.grants
      .map((snap) => grants.find((g) => g.id === snap.id))
      .filter((g): g is z.infer<typeof grantSchemaExtended> => !!g)

    return Ok({
      limit: merged.limit,
      allowOverage: merged.allowOverage,
      mergingPolicy: merged.mergingPolicy,
      activeGrants,
      winningGrant,
      effectiveAt: merged.effectiveAt,
      expiresAt: merged.expiresAt,
      resetConfig: resetConfig ?? billingConfig ?? null,
      featureType: bestPriorityGrant.featurePlanVersion.featureType,
      aggregationMethod: bestPriorityGrant.featurePlanVersion.aggregationMethod,
      grantsSnapshot: merged.grants,
    })
  }

  /**
   * Computes a single entitlement from a list of grants for a feature.
   * This is the core merging logic.
   * @param grants - List of grants to compute the entitlement from
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param featureSlug - Feature slug to compute the entitlement for
   * @param now - Current time
   * @param timezone - Timezone to use for the entitlement
   * @param cycleEndAt - Cycle end at to use for the entitlement
   * @returns Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>
   * @throws UnPriceGrantError if no grants are provided
   * @throws FetchError if the entitlement cannot be computed
   */
  private async computeEntitlementFromGrants({
    grants,
    customerId,
    projectId,
    now,
    usageOverride,
  }: {
    grants: z.infer<typeof grantSchemaExtended>[]
    customerId: string
    projectId: string
    now: number
    usageOverride?: { currentCycleUsage: string; accumulatedUsage: string }
  }): Promise<Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>> {
    const computedStateResult = this.computeEntitlementState({ grants })

    if (computedStateResult.err) {
      return Err(
        new UnPriceGrantError({
          message: computedStateResult.err.message,
          subjectId: customerId,
        })
      )
    }

    const computedState = computedStateResult.val

    // all feature grants must have the same feature slug
    const featureSlug = computedState.winningGrant.featurePlanVersion.feature.slug

    // Compute version hash + current cycle boundaries
    const version = await hashStringSHA256(
      JSON.stringify({
        grants: computedState.grantsSnapshot,
      })
    )

    // get the current entitlement for the customer and feature
    const currentEntitlement = await this.db.query.entitlements.findFirst({
      where: (entitlement, { and, eq }) =>
        and(
          eq(entitlement.projectId, projectId),
          eq(entitlement.customerId, customerId),
          eq(entitlement.featureSlug, featureSlug)
        ),
    })

    const normalizeCycleUsage = currentEntitlement
      ? this.normalizeCycleUsage({
          state: {
            ...currentEntitlement,
            currentCycleUsage:
              usageOverride?.currentCycleUsage ?? currentEntitlement.currentCycleUsage,
            accumulatedUsage:
              usageOverride?.accumulatedUsage ?? currentEntitlement.accumulatedUsage,
          },
          now,
        })
      : null

    // Determine usage base
    const baseCurrentUsage = normalizeCycleUsage?.currentCycleUsage ?? "0"
    const baseAccumulatedUsage = normalizeCycleUsage?.accumulatedUsage ?? "0"

    // Prepare base entitlement data
    const entitlementData = {
      id: currentEntitlement?.id ?? newId("entitlement"),
      projectId,
      customerId,
      featureSlug,
      featureType: computedState.featureType,
      limit: computedState.limit,
      allowOverage: computedState.allowOverage,
      aggregationMethod: computedState.aggregationMethod,
      resetConfig: computedState.resetConfig,
      mergingPolicy: computedState.mergingPolicy,
      grants: computedState.grantsSnapshot,
      version,
      effectiveAt: computedState.effectiveAt,
      expiresAt: computedState.expiresAt,
      nextRevalidateAt: Date.now() + this.revalidateInterval,
      lastSyncAt: Date.now(),
      computedAt: Date.now(),
      currentCycleUsage: baseCurrentUsage,
      accumulatedUsage: baseAccumulatedUsage,
    }

    // normalize the cycle usage to handle reset cycles
    const normalizedState = this.normalizeCycleUsage({ state: entitlementData, now })

    // New entitlement - no existing entitlement to preserve
    const finalEntitlementData = {
      ...entitlementData,
      currentCycleUsage: normalizedState.currentCycleUsage,
      accumulatedUsage: normalizedState.accumulatedUsage,
      nextRevalidateAt: normalizedState.nextRevalidateAt,
      // update the last sync at and the updated at to now
      lastSyncAt: Date.now(),
      updatedAtM: Date.now(),
      computedAt: Date.now(),
    }

    const newEntitlement = await this.db
      .insert(entitlements)
      .values(finalEntitlementData)
      .onConflictDoUpdate({
        target: [entitlements.projectId, entitlements.customerId, entitlements.featureSlug],
        set: {
          ...finalEntitlementData,
        },
      })
      .returning()
      .then((rows) => rows[0])

    if (!newEntitlement) {
      return Err(
        new UnPriceGrantError({
          message: `Failed to create entitlement for feature ${featureSlug}`,
          subjectId: customerId,
        })
      )
    }

    return Ok(newEntitlement)
  }

  /**
   * Merges grants according to the specified feature type and its implicit merging policy.
   * Returns the calculated limit, overage setting, the winning grants, and the effective date range.
   */
  private mergeGrants(params: {
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    featureType?: FeatureType | undefined
    usageMode?: UsageMode | undefined
    policy?: EntitlementMergingPolicy | undefined
  }): {
    limit: number | null
    allowOverage: boolean
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    effectiveAt: number
    expiresAt: number | null
    mergingPolicy: EntitlementMergingPolicy
  } {
    const { grants, featureType, usageMode, policy: explicitPolicy } = params

    if (grants.length === 0) {
      return {
        limit: null,
        allowOverage: false,
        grants: [],
        effectiveAt: 0,
        expiresAt: null,
        mergingPolicy: "replace",
      }
    }

    // Sort by priority (higher priority first)
    const sorted = [...grants].sort((a, b) => b.priority - a.priority)

    let policy = explicitPolicy

    // If no explicit policy, derive from feature type
    if (!policy) {
      if (!featureType) {
        // Fallback to replace if neither is provided
        policy = "replace"
      } else {
        switch (featureType) {
          case "usage":
            // for usage, we sum the usage of all the grants
            // but if the usage mode is tier, we take the max limit
            if (usageMode === "tier") {
              policy = "max"
            } else {
              policy = "sum"
            }
            break
          case "package":
            policy = "max"
            break
          default:
            policy = "replace"
            break
        }
      }
    }

    // Helper to get default date range if no specific logic applies
    // Actually we should calculate dates based on the winners
    // But initial implementation can use the sorted list

    switch (policy) {
      case "sum": {
        const limit = sorted.reduce((sum, g) => sum + (g.limit ?? 0), 0)
        // Hard limit is true if ANY grant has hard limit
        const allowOverage = sorted.some((g) => g.allowOverage)

        // For sum, the validity range is the union of all grants
        const minStart = Math.min(...sorted.map((g) => g.effectiveAt))
        // max end or null if no expires at
        const maxEnd = Math.max(...sorted.map((g) => g.expiresAt ?? Number.NEGATIVE_INFINITY))

        return {
          limit: limit > 0 ? limit : null,
          allowOverage,
          // we take all the grants that were used to calculate the limit
          grants: sorted,
          effectiveAt: minStart,
          expiresAt: maxEnd === Number.NEGATIVE_INFINITY ? null : maxEnd,
          mergingPolicy: policy,
        }
      }

      case "max": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)
        const allowOverage = sorted.some((g) => g.allowOverage)
        const maxLimit = limits.length > 0 ? Math.max(...limits) : null

        // Filter grants: keep only the highest priority grant that offers the max limit
        // This ensures we have a single deterministic configuration source
        const winningGrant = sorted.find((g) => g.limit === maxLimit) || sorted[0]!

        return {
          limit: maxLimit,
          allowOverage,
          // we take the highest limit grant that was used to calculate the limit
          grants: [winningGrant],
          effectiveAt: winningGrant.effectiveAt,
          expiresAt: winningGrant.expiresAt,
          mergingPolicy: policy,
        }
      }

      case "min": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)
        const allowOverage = sorted.every((g) => g.allowOverage)
        const minLimit = limits.length > 0 ? Math.min(...limits) : null

        // Filter grants: keep only the highest priority grant that offers the min limit
        const winningGrant = sorted.find((g) => g.limit === minLimit) || sorted[0]!

        return {
          limit: minLimit,
          allowOverage,
          // we take the lowest limit grant that was used to calculate the limit
          grants: [winningGrant],
          effectiveAt: winningGrant.effectiveAt,
          expiresAt: winningGrant.expiresAt,
          mergingPolicy: policy,
        }
      }

      case "replace": {
        // Highest priority grant replaces all others
        const highest = sorted[0]!
        return {
          limit: highest.limit,
          allowOverage: highest.allowOverage,
          // grants are replaced, so we take the highest priority grant
          grants: [highest],
          effectiveAt: highest.effectiveAt,
          expiresAt: highest.expiresAt,
          mergingPolicy: policy,
        }
      }

      default: {
        // Fallback to replace
        const highest = sorted[0]!
        return {
          limit: highest.limit ?? null,
          allowOverage: !!highest.allowOverage,
          // grants are replaced, so we take the highest priority grant
          grants: [highest],
          effectiveAt: highest.effectiveAt,
          expiresAt: highest.expiresAt,
          mergingPolicy: policy,
        }
      }
    }
  }

  /**
   * Calculates the usage per feature based on the aggregation method
   * @param params - The parameters for the calculation
   * @param params.aggregationMethod - The aggregation method to use
   * @param params.usage - The usage to calculate
   * @param params.accumulatedUsage - The accumulated usage
   * @param params.currentCycleUsage - The current cycle usage
   * @returns The usage per feature
   */
  private calculateUsage({
    aggregationMethod,
    usage,
    accumulatedUsage,
    currentCycleUsage,
  }: {
    aggregationMethod: string
    usage: number
    accumulatedUsage: number
    currentCycleUsage: number
  }): {
    usage: number
    accumulatedUsage: number
  } {
    switch (aggregationMethod) {
      case "sum": {
        const newUsage = currentCycleUsage + usage
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }
      case "max": {
        const newUsage = Math.max(currentCycleUsage, usage)
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }

      case "last_during_period": {
        const newUsage = usage
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }
      case "count": {
        const newUsage = currentCycleUsage + 1
        return {
          usage: newUsage,
          accumulatedUsage: accumulatedUsage,
        }
      }
      case "count_all": {
        const newUsage = accumulatedUsage + 1
        const newAccumulatedUsage = accumulatedUsage + 1
        return {
          usage: newUsage,
          accumulatedUsage: newAccumulatedUsage,
        }
      }
      case "max_all": {
        const newUsage = Math.max(accumulatedUsage, usage)
        const newAccumulatedUsage = newUsage
        return {
          usage: newUsage,
          accumulatedUsage: newAccumulatedUsage,
        }
      }
      case "sum_all": {
        const newUsage = accumulatedUsage + usage
        const newAccumulatedUsage = newUsage
        return {
          usage: newUsage,
          accumulatedUsage: newAccumulatedUsage,
        }
      }
      default:
        return {
          usage: currentCycleUsage,
          accumulatedUsage: accumulatedUsage,
        }
    }
  }

  /**
   * Normalizes entitlement state by checking if reset boundary has been crossed.
   * This is a safety net - the database update should handle it, but this
   * ensures correctness even if recomputation hasn't happened yet.
   * @param params - The parameters for the normalization
   * @param params.state - The entitlement state to normalize
   * @param params.now - The current time
   * @returns The normalized entitlement state
   */
  private normalizeCycleUsage(params: {
    state: EntitlementState
    now: number
  }): EntitlementState {
    const { state, now } = params

    if (!state.resetConfig) {
      return state
    }

    // Calculate which reset cycle slice "now" falls into
    // This uses the existing calculateCycleWindow which already handles
    // all the anchor/interval logic correctly
    const resetCycleForNow = calculateCycleWindow({
      now: now,
      trialEndsAt: null,
      effectiveStartDate: state.effectiveAt,
      effectiveEndDate: state.expiresAt,
      config: {
        name: state.resetConfig.name,
        interval: state.resetConfig.resetInterval,
        intervalCount: state.resetConfig.resetIntervalCount,
        anchor: state.resetConfig.resetAnchor,
        planType: state.resetConfig.planType,
      },
    })

    if (!resetCycleForNow) {
      return state
    }

    // Calculate what reset cycle the last tracked reset cycle start falls into
    // (effectiveAt may have been updated to track the last reset cycle start)
    const resetCycleAtLastTracked = calculateCycleWindow({
      now: state.effectiveAt,
      trialEndsAt: null,
      effectiveStartDate: state.effectiveAt,
      effectiveEndDate: state.expiresAt,
      config: {
        name: state.resetConfig.name,
        interval: state.resetConfig.resetInterval,
        intervalCount: state.resetConfig.resetIntervalCount,
        anchor: state.resetConfig.resetAnchor,
        planType: state.resetConfig.planType,
      },
    })

    if (!resetCycleAtLastTracked) {
      return state
    }

    // Check if we've crossed into a different reset cycle slice
    // Compare the reset cycle we're currently tracking (based on effectiveAt)
    // with the reset cycle that "now" falls into
    const resetBoundaryCrossed =
      resetCycleForNow.start !== resetCycleAtLastTracked.start ||
      resetCycleForNow.end !== resetCycleAtLastTracked.end

    if (!resetBoundaryCrossed) {
      return state
    }

    // Reset Logic based on aggregation method
    let newCurrentUsage = "0"
    let newAccumulatedUsage = state.accumulatedUsage

    const currentUsageNum = Number(state.currentCycleUsage)
    const accumulatedUsageNum = Number(state.accumulatedUsage)

    switch (state.aggregationMethod) {
      case "sum":
      case "count":
        // Move current usage to accumulated
        newAccumulatedUsage = (accumulatedUsageNum + currentUsageNum).toString()
        newCurrentUsage = "0"
        break

      case "max":
        // For max, we snapshot the max reached in the cycle
        newAccumulatedUsage = Math.max(accumulatedUsageNum, currentUsageNum).toString()
        newCurrentUsage = "0"
        break

      case "last_during_period":
        newCurrentUsage = "0"
        // accumulated doesn't change or tracks history? default to no change for now
        break

      case "sum_all":
      case "count_all":
      case "max_all":
        // These methods track lifetime usage, so we generally don't reset them on cycle boundaries
        // to preserve the lifetime count/sum/max.
        newCurrentUsage = state.currentCycleUsage
        newAccumulatedUsage = state.accumulatedUsage
        break

      default:
        // Default reset behavior (sum-like)
        newAccumulatedUsage = (accumulatedUsageNum + currentUsageNum).toString()
        newCurrentUsage = "0"
        break
    }

    // Reset boundary crossed - but we can't update currentCycleStartAt/currentCycleEndAt
    // because those represent billing cycles, not reset cycles!
    // This is the fundamental problem - you need separate fields for reset cycle boundaries
    return {
      ...state,
      currentCycleUsage: newCurrentUsage,
      accumulatedUsage: newAccumulatedUsage,
      effectiveAt: resetCycleForNow.start,
      nextRevalidateAt: resetCycleForNow.start + this.revalidateInterval,
    }
  }

  /**
   * Check if usage is allowed and give the information of the grants that were used to calculate the result
   */
  public verify(params: { state: EntitlementState; now: number }): VerificationResult {
    const { state, now } = params

    // Normalize cycle usage (safety net)
    const normalizedState = this.normalizeCycleUsage({ state, now })

    const { err, val: validatedState } = this.validateEntitlementState({
      state: normalizedState,
      now,
    })

    if (err) {
      return {
        allowed: false,
        message: err.message,
        deniedReason: "ENTITLEMENT_ERROR",
        usage: 0,
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
      limit: validatedState.limit ?? undefined,
    }
  }

  /**
   * Consume usage from grants by priority
   * Here we decided to make a trade-off. Instead of calculating the attribution here at consumption time,
   * we calculated dynamically at billing service time. So we are more flexible when handling edge cases.
   */
  public consume(params: {
    state: EntitlementState
    amount: number
    now: number
  }): ReportUsageResult & {
    effectiveAt?: number | null
    expiresAt?: number | null
    accumulatedUsage?: string
  } {
    const { state, amount, now } = params

    // Normalize cycle usage (safety net)
    const normalizedState = this.normalizeCycleUsage({ state, now })

    // 1. Get active grants at this timestamp
    const { err, val: validatedState } = this.validateEntitlementState({
      state: normalizedState,
      now,
    })

    if (err) {
      return {
        allowed: false,
        usage: 0,
        limit: undefined,
        message: err.message,
        deniedReason: "ENTITLEMENT_ERROR",
      }
    }

    const activeGrants = validatedState.grants

    // 2. Validate usage
    const { err: usageErr, val: validatedUsage } = this.validateUsage({
      state: normalizedState,
      amount: amount,
    })

    if (usageErr) {
      return {
        allowed: false,
        usage: amount,
        limit: undefined,
        message: usageErr.message,
        deniedReason: "INCORRECT_USAGE_REPORTING",
      }
    }

    // 3. Recalculate effective limit from active grants
    const {
      limit: effectiveLimit,
      allowOverage,
      expiresAt,
    } = this.mergeGrants({
      grants: activeGrants,
      // policy was already calculated use the same
      policy: validatedState.mergingPolicy,
    })

    // 3. Calculate the new usage
    const usage = this.calculateUsage({
      aggregationMethod: validatedState.aggregationMethod,
      usage: validatedUsage,
      accumulatedUsage: Number(normalizedState.accumulatedUsage),
      currentCycleUsage: Number(normalizedState.currentCycleUsage),
    })

    const newUsage = usage.usage
    const withinLimit = effectiveLimit === null || newUsage <= effectiveLimit
    // threshold of 90% to send a notification
    // TODO: use the notifyUsageThreshold from the plan version feature
    const threshold = effectiveLimit ? Math.floor(effectiveLimit * 0.9) : null
    const notifiedOverLimit = threshold !== null && newUsage > threshold

    const allowed = withinLimit || allowOverage

    if (!allowed) {
      return {
        allowed: false,
        usage: Number(normalizedState.currentCycleUsage),
        accumulatedUsage: normalizedState.accumulatedUsage,
        effectiveAt: normalizedState.effectiveAt,
        limit: effectiveLimit,
        message: "Limit exceeded",
        deniedReason: "LIMIT_EXCEEDED",
        notifiedOverLimit: false,
      }
    }

    // 4. Return result without attribution
    return {
      allowed,
      usage: newUsage,
      accumulatedUsage: usage.accumulatedUsage.toString(),
      effectiveAt: normalizedState.effectiveAt, // normalizedState has the updated effectiveAt from normalizeCycleUsage
      expiresAt: expiresAt,
      limit: effectiveLimit ?? undefined,
      message: "Allowed",
      deniedReason: undefined,
      notifiedOverLimit: notifiedOverLimit,
    }
  }

  private validateUsage(params: { state: EntitlementState; amount: number }): Result<
    number,
    UnPriceGrantError
  > {
    const { state, amount } = params

    if (amount < 0 && !["sum", "sum_all"].includes(state.aggregationMethod)) {
      return Err(
        new UnPriceGrantError({
          message: `Usage cannot be negative when the feature type is not sum or sum_all, got ${state.aggregationMethod}. This will disturb aggregations.`,
          subjectId: state.customerId,
        })
      )
    }

    // check flat features
    if (state.featureType === "flat") {
      return Err(
        new UnPriceGrantError({
          message: "Flat feature cannot be used to consume usage",
          subjectId: state.customerId,
        })
      )
    }

    return Ok(amount)
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
  private validateEntitlementState(params: { state: EntitlementState; now: number }): Result<
    EntitlementState,
    UnPriceGrantError
  > {
    const { state, now } = params

    // Then check if any grant is active at this timestamp
    const activeGrants = this.getActiveGrantsAtTimestamp({ grants: state.grants, now })

    if (activeGrants.length === 0) {
      return Err(
        new UnPriceGrantError({
          message: `No active grant found for customer ${state.customerId} and project ${state.projectId} and feature ${state.featureSlug}`,
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
