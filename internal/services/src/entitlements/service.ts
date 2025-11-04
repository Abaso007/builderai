import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { and, eq } from "@unprice/db"
import { entitlements } from "@unprice/db/schema"
import type { Logger } from "@unprice/logging"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { GrantsManager } from "./grants"
import type { EntitlementStorageProvider } from "./storage-provider"
import type {
  ConsumptionResult,
  EntitlementState,
  UsageRecord,
  VerificationRecord,
  VerificationResult,
} from "./types"

/**
 * Simplified Entitlement Service
 *
 * Strategy:
 * - Keep usage in cache (DO/Redis) for low latency
 * - Smart revalidation: lightweight version check, only reload if changed
 * - All logic encapsulated in service (minimize round-trips)
 * - Buffering support for batch analytics
 */
export class EntitlementService {
  private readonly grantsManager: GrantsManager
  private readonly revalidateInterval: number
  private readonly db: Database
  private readonly storage: EntitlementStorageProvider
  private readonly logger: Logger
  private readonly analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly cache: Cache
  private readonly metrics: Metrics

  constructor(opts: {
    db: Database
    storage: EntitlementStorageProvider
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    config?: {
      revalidateInterval?: number // How often to check for version changes
    }
  }) {
    this.revalidateInterval = opts.config?.revalidateInterval ?? 300000 // 5 minutes default
    this.grantsManager = new GrantsManager({
      db: opts.db,
      logger: opts.logger,
      analytics: opts.analytics,
      waitUntil: opts.waitUntil,
      cache: opts.cache,
      metrics: opts.metrics,
    })
    this.db = opts.db
    this.storage = opts.storage
    this.logger = opts.logger
    this.analytics = opts.analytics
    this.waitUntil = opts.waitUntil
    this.cache = opts.cache
    this.metrics = opts.metrics
  }

  /**
   * Check if usage is allowed (low latency)
   * Handles cache miss and revalidation internally (single network call)
   */
  async can(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<VerificationResult> {
    const state = await this.getStateWithRevalidation(params)

    if (!state) {
      // Buffer verification failure if provider supports it
      if (this.storage.bufferVerification) {
        await this.storage.bufferVerification({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
          timestamp: Date.now(),
          success: false,
          deniedReason: "NO_ENTITLEMENT",
        })
      }

      return {
        allowed: false,
        message: "No entitlement found",
        usage: 0,
        limit: null,
      }
    }

    const result = this.grantsManager.verify(state)

    // Buffer verification if provider supports it
    if (this.storage.bufferVerification) {
      await this.storage.bufferVerification({
        customerId: params.customerId,
        projectId: params.projectId,
        featureSlug: params.featureSlug,
        timestamp: Date.now(),
        success: result.allowed,
        deniedReason: result.allowed ? undefined : "LIMIT_EXCEEDED",
      })
    }

    return result
  }

  /**
   * Report usage with priority-based consumption
   * Handles revalidation internally (single network call)
   */
  async reportUsage(params: {
    customerId: string
    projectId: string
    featureSlug: string
    amount: number
  }): Promise<ConsumptionResult> {
    // Get state with automatic revalidation (handles cache miss internally)
    const state = await this.getStateWithRevalidation(params)

    if (!state) {
      return {
        success: false,
        message: "No entitlement found",
        usage: 0,
        limit: null,
        consumedFrom: [],
      }
    }

    // Consume with priority
    const result = this.grantsManager.consume(state, params.amount)

    // Update state in cache
    if (result.success) {
      state.currentUsage = result.usage
      await this.storage.set({ state })

      // Buffer usage records if provider supports it
      if (this.storage.bufferUsageRecord) {
        for (const consumed of result.consumedFrom) {
          await this.storage.bufferUsageRecord({
            customerId: params.customerId,
            projectId: params.projectId,
            featureSlug: params.featureSlug,
            usage: consumed.amount,
            timestamp: Date.now(),
            grantId: consumed.grantId,
            grantType: consumed.type,
            grantPriority: consumed.priority,
          })
        }
      }

      // Async sync to DB (don't block)
      this.syncToDB(state).catch((err) => {
        this.logger.error("Failed to sync to DB", { error: err.message })
      })
    }

    return result
  }

  /**
   * Prewarm cache with entitlement snapshots
   */
  async prewarm(states: EntitlementState[]): Promise<void> {
    const now = Date.now()
    for (const state of states) {
      // Ensure revalidation fields are set
      if (!state.nextRevalidateAt) {
        state.nextRevalidateAt = now + this.revalidateInterval
      }
      if (!state.computedAt) {
        state.computedAt = now
      }
      await this.storage.set({ state })
    }
  }

  /**
   * Flush buffered records (for DO alarms or periodic timers)
   * Returns the buffered records so you can send them to Tinybird
   */
  async flush(): Promise<{
    usage: UsageRecord[]
    verifications: VerificationRecord[]
  }> {
    if (this.storage.flush) {
      const { val, err } = await this.storage.flush()
      if (err) {
        this.logger.error("Failed to flush", { error: err.message })
        return { usage: [], verifications: [] }
      }
      return val
    }
    return { usage: [], verifications: [] }
  }

  /**
   * Invalidate cache (force refresh from DB)
   */
  async invalidate(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<void> {
    await this.storage.delete(params)
  }

  /**
   * Get state with smart revalidation
   *
   * Strategy:
   * 1. Try cache first
   * 2. If cache miss, load from DB
   * 3. If cached but nextRevalidateAt passed:
   *    a. Do lightweight version check (just query version)
   *    b. If version differs, reload full entitlement
   *    c. Otherwise, just update nextRevalidateAt
   *
   * This minimizes DB queries while staying in sync
   */
  private async getStateWithRevalidation(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<EntitlementState | null> {
    const now = Date.now()
    const { val: cached } = await this.storage.get(params)

    // Cache miss - load from DB
    if (!cached) {
      this.logger.debug("Cache miss, loading from DB", params)
      return this.loadFromDB(params, now)
    }

    // Cache hit - check if we need to revalidate
    if (now >= cached.nextRevalidateAt) {
      this.logger.debug("Revalidation time, checking version", params)

      // Lightweight version check (just query version number)
      const dbVersion = await this.db.query.entitlements.findFirst({
        where: (e, { and, eq }) =>
          and(
            eq(e.customerId, params.customerId),
            eq(e.projectId, params.projectId),
            eq(e.featureSlug, params.featureSlug)
          ),
        columns: { version: true, computedAt: true },
      })

      if (!dbVersion) {
        // Entitlement deleted, invalidate cache
        await this.storage.delete(params)
        return null
      }

      // Version mismatch or snapshot updated - reload
      if (dbVersion.version !== cached.version || dbVersion.computedAt !== cached.computedAt) {
        this.logger.info("Version mismatch detected, reloading", {
          ...params,
          cachedVersion: cached.version,
          dbVersion: dbVersion.version,
          cachedComputedAt: cached.computedAt,
          dbComputedAt: dbVersion.computedAt,
        })
        return this.loadFromDB(params, now)
      }

      // Version matches - just update revalidation time
      cached.nextRevalidateAt = now + this.revalidateInterval
      await this.storage.set({ state: cached })
    }

    return cached
  }

  /**
   * Load full entitlement from DB
   */
  private async loadFromDB(
    params: {
      customerId: string
      projectId: string
      featureSlug: string
    },
    now: number
  ): Promise<EntitlementState | null> {
    const entitlement = await this.db.query.entitlements.findFirst({
      where: (e, { and, eq }) =>
        and(
          eq(e.customerId, params.customerId),
          eq(e.projectId, params.projectId),
          eq(e.featureSlug, params.featureSlug)
        ),
    })

    if (!entitlement) return null

    const state: EntitlementState = {
      id: entitlement.id,
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      featureSlug: entitlement.featureSlug,
      featureType: entitlement.featureType,
      currentUsage: Number(entitlement.currentCycleUsage),
      limit: entitlement.effectiveLimit,
      grants: (entitlement.grants ?? [])
        .map((g) => ({
          id: g.id,
          priority: g.priority,
          type: g.type,
          limit: g.limit,
          consumed: 0, // Start fresh from snapshot
        }))
        .sort((a, b) => b.priority - a.priority),
      version: entitlement.version,
      lastSyncAt: now,
      nextRevalidateAt: now + this.revalidateInterval,
      computedAt: entitlement.computedAt,
    }

    // Update cache
    await this.storage.set({ state })

    return state
  }

  /**
   * Sync usage back to DB (async, non-blocking)
   */
  private async syncToDB(state: EntitlementState): Promise<void> {
    await this.db
      .update(entitlements)
      .set({
        currentCycleUsage: state.currentUsage.toString(),
        lastUsageUpdateAt: Date.now(),
      })
      .where(and(eq(entitlements.id, state.id), eq(entitlements.projectId, state.projectId)))
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
