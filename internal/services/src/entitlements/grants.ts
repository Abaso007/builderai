import { type Database, and, eq, inArray } from "@unprice/db"
import { entitlements, grants } from "@unprice/db/schema"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import {
  type FeatureType,
  calculateCycleWindow,
  type entitlementGrantsSnapshotSchema,
} from "@unprice/db/validators"
import type {
  Consumption,
  EntitlementMergingPolicy,
  EntitlementState,
  ReportUsageResult,
  VerificationResult,
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

  constructor({
    db,
    logger,
  }: {
    db: Database
    logger: Logger
  }) {
    this.db = db
    this.logger = logger
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
    grant: typeof grants.$inferInsert
  }): Promise<Result<typeof grants.$inferSelect, UnPriceGrantError>> {
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

    // get all grants for a project and customer
    // Get customer's subscription to find planId
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
          where: (grant, { and, eq, gte, or, isNull, not, notInArray }) =>
            and(
              eq(grant.projectId, projectId),
              eq(grant.subjectId, subject.subjectId),
              eq(grant.subjectType, subject.subjectType),
              eq(grant.autoRenew, true),
              // we only renew subscriptions and trials through the subscription renew
              notInArray(grant.type, ["subscription", "trial"]),
              not(eq(grant.deleted, true)),
              // already expired
              or(isNull(grant.expiresAt), gte(grant.expiresAt, now)) // expiresAt >= now or null
            ),
          orderBy: (grant, { desc }) => desc(grant.priority),
        })
      )
    )

    const renewedGrants = []
    for (const grant of allGrants.flat()) {
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
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<EntitlementState[], FetchError | UnPriceGrantError>> {
    try {
      // Get customer's subscription to find planId
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
            where: (grant, { and, eq, lte, gt, or, isNull, not }) =>
              and(
                eq(grant.projectId, projectId),
                eq(grant.subjectId, subject.subjectId),
                eq(grant.subjectType, subject.subjectType),
                not(eq(grant.deleted, true)),
                lte(grant.effectiveAt, now), // effectiveAt >= now
                or(isNull(grant.expiresAt), gt(grant.expiresAt, now)) // expiresAt <= now or null
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

        // compute the entitlement for each feature in the current cycle
        // this is idempotent, so if the entitlement already exists, it will be updated
        const entitlementResult = await this.computeEntitlementFromGrants({
          grants: featureGrants,
          customerId,
          projectId,
          now,
        })

        if (entitlementResult.err) {
          this.logger.error("Failed to compute entitlement for feature", {
            featureSlug,
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
  }: {
    grants: z.infer<typeof grantSchemaExtended>[]
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>> {
    if (grants.length === 0) {
      return Err(
        new UnPriceGrantError({
          message: "No grants provided",
          subjectId: customerId,
        })
      )
    }

    // Sort by priority (higher first) to preserve consumption order and get the best priority grant
    // This determines the "intent" (feature type) of the entitlement configuration
    const ordered = [...grants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    const bestPriorityGrant = ordered[0]!

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
      allowOverage: g.allowOverage,
      featurePlanVersionId: g.featurePlanVersionId,
      subscriptionItemId: g.subscriptionItem?.id ?? null,
      subscriptionPhaseId: g.subscriptionItem?.subscriptionPhaseId ?? null,
      subscriptionId: g.subscriptionItem?.subscription?.id ?? null,
    }))

    // Merge grants according to merging policy derived from feature type
    const merged = this.mergeGrants({
      grants: grantsSnapshot,
      featureType: bestPriorityGrant.featurePlanVersion.featureType as FeatureType,
    })

    // The effective configuration should come from the "winning" grant(s)
    // If merged.grants is empty (shouldn't happen if grants.length > 0), fall back to bestPriorityGrant
    // But since we filter grants in mergeGrants, we need to find the corresponding full grant object
    // for the winning grant ID to get full configuration (resetConfig etc).

    const winningGrantSnapshot = merged.grants[0] ?? grantsSnapshot[0]!
    const winningGrant = grants.find((g) => g.id === winningGrantSnapshot.id) ?? bestPriorityGrant

    // all feature grants must have the same feature slug
    const featureSlug = winningGrant.featurePlanVersion.feature.slug

    // Derive overall effective/expires for cycle computation
    // Compute cycle window from reset config (half-open style via bounds)
    // Use the winning grant's reset config
    const resetConfig = winningGrant.featurePlanVersion.resetConfig
      ? {
          ...winningGrant.featurePlanVersion.resetConfig,
          resetAnchor: winningGrant.anchor,
        }
      : null

    // Compute version hash + current cycle boundaries
    const version = await hashStringSHA256(
      JSON.stringify({
        grants: merged.grants,
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

    // Prepare base entitlement data
    const entitlementData = {
      id: currentEntitlement?.id ?? newId("entitlement"),
      projectId,
      customerId,
      featureSlug,
      featureType: bestPriorityGrant.featurePlanVersion.featureType as FeatureType,
      limit: merged.limit,
      allowOverage: merged.allowOverage,
      aggregationMethod: bestPriorityGrant.featurePlanVersion.aggregationMethod,
      resetConfig,
      mergingPolicy: merged.mergingPolicy,
      grants: merged.grants,
      version,
      effectiveAt: merged.effectiveAt,
      expiresAt: merged.expiresAt,
      // revalidate every hour
      nextRevalidateAt: Date.now() + 1000 * 60 * 60,
      lastSyncAt: Date.now(),
      computedAt: Date.now(),
      currentCycleUsage: "0",
      accumulatedUsage: "0",
    }

    // normalize the cycle usage to handle reset cycles
    const normalizedState = this.normalizeCycleUsage({ state: entitlementData, now })

    // New entitlement - no existing entitlement to preserve
    const newEntitlement = await this.db
      .insert(entitlements)
      .values(entitlementData)
      .onConflictDoUpdate({
        target: [entitlements.projectId, entitlements.customerId, entitlements.featureSlug],
        set: {
          ...entitlementData,
          // update usage
          currentCycleUsage: normalizedState.currentCycleUsage,
          accumulatedUsage: normalizedState.accumulatedUsage,
          nextRevalidateAt: normalizedState.nextRevalidateAt,
          // update the last sync at and the updated at to now
          lastSyncAt: Date.now(),
          updatedAtM: Date.now(),
          computedAt: Date.now(),
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

  // TODO: can and reportUsage as one method as well
  // something like try and consume

  /**
   * Merges grants according to the specified feature type and its implicit merging policy.
   * Returns the calculated limit, overage setting, the winning grants, and the effective date range.
   */
  private mergeGrants(params: {
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    featureType?: FeatureType | undefined
    policy?: EntitlementMergingPolicy | undefined
  }): {
    limit: number | null
    allowOverage: boolean
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    effectiveAt: number
    expiresAt: number | null
    mergingPolicy: EntitlementMergingPolicy
  } {
    const { grants, featureType, policy: explicitPolicy } = params

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
          case "flat":
            policy = "replace"
            break
          case "tier":
            policy = "max"
            break
          case "usage":
            policy = "sum"
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

    // The key insight: We need to track what reset cycle slice we were last in
    // Since we don't store this separately, we can infer it by checking:
    // If currentCycleUsage > 0, we were tracking usage for SOME reset cycle
    // We can calculate what reset cycle the billing cycle started in, and
    // compare with what reset cycle "now" is in

    // Calculate what reset cycle the billing cycle start falls into
    const resetCycleAtBillingStart = calculateCycleWindow({
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

    if (!resetCycleAtBillingStart) {
      return state
    }

    // Check if we've crossed into a different reset cycle slice
    // If now is in a different reset cycle than the billing start, we've crossed
    // (assuming we started tracking at billing start)
    const resetBoundaryCrossed =
      resetCycleForNow.start !== resetCycleAtBillingStart.start ||
      resetCycleForNow.end !== resetCycleAtBillingStart.end

    if (!resetBoundaryCrossed) {
      return state
    }

    // Reset boundary crossed - but we can't update currentCycleStartAt/currentCycleEndAt
    // because those represent billing cycles, not reset cycles!
    // This is the fundamental problem - you need separate fields for reset cycle boundaries
    return {
      ...state,
      currentCycleUsage: "0",
      accumulatedUsage: (
        BigInt(state.accumulatedUsage) + BigInt(state.currentCycleUsage)
      ).toString(),
      effectiveAt: resetCycleForNow.start,
      nextRevalidateAt: Date.now() + 1000 * 60 * 60,
    }
  }

  /**
   * Check if usage is allowed and give the information of the grants that were used to calculate the result
   */
  public verify(params: { state: EntitlementState; now: number }): VerificationResult {
    const { state, now } = params

    // Normalize cycle usage (safety net)
    const normalizedState = this.normalizeCycleUsage({ state, now })

    const { err, val: validatedState } = this.validateEntitlementAccess({
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
   * Returns which grants were consumed for billing attribution
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
    const { err, val: validatedState } = this.validateEntitlementAccess({
      state: normalizedState,
      now,
    })

    if (err) {
      return {
        allowed: false,
        usage: 0,
        limit: undefined,
        consumedFrom: [],
        message: err.message,
      }
    }

    const activeGrants = validatedState.grants

    // 2. Recalculate effective limit from active grants (in case grants expired)
    const {
      limit: effectiveLimit,
      allowOverage,
      expiresAt,
      effectiveAt,
    } = this.mergeGrants({
      grants: activeGrants,
      policy: validatedState.mergingPolicy,
    })

    // 3. Check unified limit (no per-grant tracking needed)
    const newUsage = Number(normalizedState.currentCycleUsage) + amount
    const withinLimit = effectiveLimit === null || newUsage <= effectiveLimit

    const allowed = withinLimit || allowOverage

    if (!allowed) {
      return {
        allowed: false,
        usage: Number(normalizedState.currentCycleUsage),
        accumulatedUsage: normalizedState.accumulatedUsage,
        effectiveAt: normalizedState.effectiveAt,
        limit: effectiveLimit,
        consumedFrom: [],
        message: "Limit exceeded",
        deniedReason: "LIMIT_EXCEEDED",
      }
    }

    // 4. Determine which grants would be consumed for billing attribution
    const consumedFrom = this.attributeConsumption({
      grants: activeGrants,
      amount,
    })

    return {
      allowed,
      usage: newUsage,
      accumulatedUsage: normalizedState.accumulatedUsage,
      effectiveAt: effectiveAt,
      expiresAt: expiresAt,
      limit: effectiveLimit ?? undefined,
      consumedFrom,
      message: allowed ? "Allowed" : "Limit exceeded",
      deniedReason: allowed ? undefined : "LIMIT_EXCEEDED",
      // TODO: handle notified over limit
      notifiedOverLimit: false,
    }
  }

  /**
   * Determine which grants would be consumed for billing attribution
   */
  private attributeConsumption(params: {
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    amount: number
  }): Consumption[] {
    const { grants, amount } = params
    // Sort by priority
    const sorted = [...grants].sort((a, b) => b.priority - a.priority)

    // Attribute consumption by priority (for billing records)
    // This is just for attribution, not for limit checking
    const attribution: Consumption[] = []
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
        featurePlanVersionId: grant.featurePlanVersionId,
        subscriptionItemId: grant.subscriptionItemId,
        subscriptionPhaseId: grant.subscriptionPhaseId,
        subscriptionId: grant.subscriptionId,
      })

      remaining -= toAttribute
    }

    // If there is still remaining usage (overage), find a grant that allows overage to attribute it to
    if (remaining > 0) {
      // Find the highest priority grant that allows overage
      const overageGrant = sorted.find((g) => g.allowOverage)

      if (overageGrant) {
        // Check if we already have an entry for this grant
        const existingEntry = attribution.find((a) => a.grantId === overageGrant.id)

        if (existingEntry) {
          existingEntry.amount += remaining
        } else {
          // Add new entry for overage
          attribution.push({
            grantId: overageGrant.id,
            amount: remaining,
            priority: overageGrant.priority,
            type: overageGrant.type,
            featurePlanVersionId: overageGrant.featurePlanVersionId,
            subscriptionItemId: overageGrant.subscriptionItemId,
            subscriptionPhaseId: overageGrant.subscriptionPhaseId,
            subscriptionId: overageGrant.subscriptionId,
          })
        }
      } else {
        // If there is no overage grant, we need to notify the user we take the first grant and attribute the remaining to it
        const firstGrant = sorted[0]!
        attribution.push({
          grantId: firstGrant.id,
          amount: remaining,
          priority: firstGrant.priority,
          type: firstGrant.type,
          featurePlanVersionId: firstGrant.featurePlanVersionId,
          subscriptionItemId: firstGrant.subscriptionItemId,
          subscriptionPhaseId: firstGrant.subscriptionPhaseId,
          subscriptionId: firstGrant.subscriptionId,
        })
        remaining = 0
      }
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
