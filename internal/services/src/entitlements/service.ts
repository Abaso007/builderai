import type { Analytics, AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { and, eq } from "@unprice/db"
import { entitlements } from "@unprice/db/schema"
import { add, dinero, formatMoney, toDecimal } from "@unprice/db/utils"
import type { Dinero } from "@unprice/db/utils"
import {
  type CurrentUsage,
  type EntitlementState,
  type ReportUsageRequest,
  type ReportUsageResult,
  type VerificationResult,
  type VerifyRequest,
  calculateFlatPricePlan,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { BillingService } from "../billing"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { retry } from "../utils/retry"
import { UnPriceEntitlementError, type UnPriceEntitlementStorageError } from "./errors"
import { GrantsManager } from "./grants"
import type { UnPriceEntitlementStorage } from "./storage-provider"

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
  private readonly syncToDBInterval: number
  private readonly db: Database
  private readonly storage: UnPriceEntitlementStorage
  private readonly logger: Logger
  private readonly analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly cache: Cache
  private readonly metrics: Metrics

  constructor(opts: {
    db: Database
    storage: UnPriceEntitlementStorage
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    config?: {
      revalidateInterval?: number // How often to check for version changes
      syncToDBInterval?: number // How often to sync to DB
    }
  }) {
    this.revalidateInterval = opts.config?.revalidateInterval ?? 300000 // 5 minutes default
    this.syncToDBInterval = opts.config?.syncToDBInterval ?? 60000 // 1 minute default

    this.grantsManager = new GrantsManager({
      db: opts.db,
      logger: opts.logger,
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
  async verify(params: VerifyRequest): Promise<VerificationResult> {
    const state = await this.getStateWithRevalidation({
      customerId: params.customerId,
      projectId: params.projectId,
      featureSlug: params.featureSlug,
      now: params.timestamp,
      // if fromCache is false, we load from cache with swr and if not found, we load from DB
      skipCache: !params.fromCache,
    })

    if (!state) {
      await this.storage.insertVerification({
        customerId: params.customerId,
        projectId: params.projectId,
        featureSlug: params.featureSlug,
        timestamp: params.timestamp,
        allowed: 0,
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        metadata: params.metadata,
        latency: performance.now() - params.performanceStart,
        requestId: params.requestId,
        createdAt: Date.now(),
      })

      return {
        allowed: false,
        message: "No entitlement found for the given customer, project and feature",
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        usage: 0,
        limit: undefined,
      }
    }

    const result = this.grantsManager.verify({ state, now: params.timestamp })
    const latency = performance.now() - params.performanceStart

    // Insert verification record
    await this.storage.insertVerification({
      customerId: params.customerId,
      projectId: params.projectId,
      featureSlug: params.featureSlug,
      timestamp: params.timestamp,
      allowed: result.allowed ? 1 : 0,
      deniedReason: result.deniedReason ?? undefined,
      metadata: params.metadata,
      latency,
      requestId: params.requestId,
      createdAt: Date.now(),
    })

    return { ...result, latency }
  }

  /**
   * Report usage with priority-based consumption
   * Handles revalidation internally (single network call)
   */
  async reportUsage(params: ReportUsageRequest): Promise<ReportUsageResult> {
    // Get state with automatic revalidation (handles cache miss internally)
    const state = await this.getStateWithRevalidation({
      customerId: params.customerId,
      projectId: params.projectId,
      featureSlug: params.featureSlug,
      now: params.timestamp,
      // if fromCache is false, we load from cache with swr and if not found, we load from DB
      skipCache: !params.fromCache,
    })

    if (!state) {
      return {
        allowed: false,
        message: "No entitlement found for the given customer, project and feature",
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        usage: 0,
        limit: undefined,
      }
    }

    // Consume with priority
    const result = this.grantsManager.consume({
      state,
      amount: params.usage,
      now: params.timestamp,
    })

    // Update state in cache
    if (result.allowed) {
      // update the current cycle usage if it is provided
      state.currentCycleUsage = result.usage?.toString() ?? "0"

      // update the accumulated usage if it is provided
      if (result.accumulatedUsage) {
        state.accumulatedUsage = result.accumulatedUsage
      }

      // update the effective at if it is provided
      if (result.effectiveAt !== undefined && result.effectiveAt !== null) {
        state.effectiveAt = result.effectiveAt
      }

      // update the usage in the storage
      await this.storage.set({ state })

      await this.storage.insertUsageRecord({
        customerId: params.customerId,
        projectId: params.projectId,
        featureSlug: params.featureSlug,
        usage: params.usage,
        timestamp: params.timestamp,
        idempotenceKey: params.idempotenceKey,
        requestId: params.requestId,
        createdAt: Date.now(),
        metadata: params.metadata,
        deleted: 0,
      })

      // Async sync to DB (don't block)
      this.waitUntil(this.syncToDB(state))
    }

    return result
  }

  /**
   * Send verifications to analytics
   */
  private async sendVerificationsToAnalytics({
    verifications,
  }: {
    verifications: AnalyticsVerification[]
  }): Promise<
    Result<
      {
        success: boolean
        quarantined: number
      },
      UnPriceEntitlementStorageError
    >
  > {
    try {
      const transformedEvents = verifications.map((event) => ({
        featureSlug: event.featureSlug,
        customerId: event.customerId,
        projectId: event.projectId,
        timestamp: event.timestamp,
        status: event.deniedReason,
        metadata: event.metadata,
        latency: event.latency ? Number(event.latency) : 0,
        requestId: event.requestId,
        allowed: event.allowed,
      }))

      if (transformedEvents.length === 0) {
        return Ok({
          success: true,
          quarantined: 0,
        })
      }

      const data = await this.analytics
        .ingestFeaturesVerification(transformedEvents)
        .catch((e) => {
          this.logger.error(`Failed in ingestFeaturesVerification from do ${e.message}`, {
            error: JSON.stringify(e),
            customerId: transformedEvents[0]?.customerId,
            projectId: transformedEvents[0]?.projectId,
          })

          throw e
        })
        .then(async (data) => {
          const rows = data?.successful_rows ?? 0
          const quarantined = data?.quarantined_rows ?? 0
          const total = rows + quarantined

          if (quarantined > 0) {
            this.logger.warn("quarantined verifications", {
              quarantined,
            })
          }

          if (total >= verifications.length) {
            this.logger.info(`Processed ${total} verifications`, {
              featureSlug: transformedEvents[0]?.featureSlug,
              customerId: transformedEvents[0]?.customerId,
              projectId: transformedEvents[0]?.projectId,
            })
          } else {
            this.logger.debug(
              "the total of verifications sent to tinybird are not the same as the total of verifications in the db",
              {
                total,
                expected: verifications.length,
                featureSlug: transformedEvents[0]?.featureSlug,
                customerId: transformedEvents[0]?.customerId,
                projectId: transformedEvents[0]?.projectId,
              }
            )
          }

          return data
        })

      return Ok({
        success: true,
        quarantined: data.quarantined_rows ?? 0,
      })
    } catch (error) {
      this.logger.error(
        `Failed to send verifications to analytics ${error instanceof Error ? error.message : "unknown error"}`,
        {
          error: error instanceof Error ? JSON.stringify(error) : "unknown error",
          customerId: verifications[0]?.customerId,
          projectId: verifications[0]?.projectId,
        }
      )

      throw error
    }
  }

  /**
   * Send usage records to analytics
   */
  private async sendUsageRecordsToAnalytics({
    usageRecords,
  }: {
    usageRecords: AnalyticsUsage[]
  }): Promise<
    Result<
      {
        success: boolean
        quarantined: number
      },
      UnPriceEntitlementStorageError
    >
  > {
    // Create a Map to deduplicate events based on their unique identifiers
    const uniqueEvents = new Map()
    for (const event of usageRecords) {
      if (!uniqueEvents.has(event.idempotenceKey)) {
        uniqueEvents.set(event.idempotenceKey, {
          ...event,
          metadata: event.metadata,
        })
      }
    }

    const deduplicatedEvents = Array.from(uniqueEvents.values())

    if (deduplicatedEvents.length === 0) {
      return Ok({
        success: true,
        quarantined: 0,
      })
    }

    try {
      const data = await this.analytics
        .ingestFeaturesUsage(deduplicatedEvents)
        .catch((e) => {
          this.logger.error(`Failed to send ${deduplicatedEvents.length} events to Analytics:`, {
            error: e.message,
            customerId: deduplicatedEvents[0]?.customerId,
            projectId: deduplicatedEvents[0]?.projectId,
          })
          throw e
        })
        .then(async (data) => {
          const rows = data?.successful_rows ?? 0
          const quarantined = data?.quarantined_rows ?? 0
          const total = rows + quarantined

          if (total >= deduplicatedEvents.length) {
            this.logger.debug(
              `successfully sent ${deduplicatedEvents.length} usage records to Analytics`,
              {
                rows: total,
              }
            )
          } else {
            this.logger.debug(
              "the total of usage records sent to Analytics are not the same as the total of usage records in the db",
              {
                total,
                expected: deduplicatedEvents.length,
                customerId: deduplicatedEvents[0]?.customerId,
                projectId: deduplicatedEvents[0]?.projectId,
              }
            )
          }

          this.logger.info(`Processed ${total} usage events`, {
            featureSlug: deduplicatedEvents[0]?.featureSlug,
            customerId: deduplicatedEvents[0]?.customerId,
            projectId: deduplicatedEvents[0]?.projectId,
          })

          return data
        })

      return Ok({
        success: true,
        quarantined: data?.quarantined_rows ?? 0,
      })
    } catch (error) {
      this.logger.error("Failed to send usage records to Analytics:", {
        error: error instanceof Error ? error.message : "unknown error",
        customerId: usageRecords[0]?.customerId,
        projectId: usageRecords[0]?.projectId,
        featureSlug: usageRecords[0]?.featureSlug,
      })
      throw error
    }
  }

  /**
   * Prewarm cache with entitlement snapshots
   */
  async prewarm({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<void> {
    // invalidate any entitlements first
    await this.invalidateEntitlements({
      customerId,
      projectId,
    })

    // compute the grants for the customer
    const { val: entitlements, err } = await this.grantsManager.computeGrantsForCustomer({
      customerId,
      projectId,
      now,
    })

    if (err) {
      this.logger.error("Failed to compute grants for customer", { error: err.message })
      throw err
    }

    // create promises to set the entitlements in the storage and cache
    const promises = entitlements.map((entitlement) => {
      return Promise.all([
        this.storage.set({ state: entitlement }),
        this.cache.customerEntitlement.set(
          this.makeEntitlementKey({
            customerId: entitlement.customerId,
            projectId: entitlement.projectId,
            featureSlug: entitlement.featureSlug,
          }),
          entitlement
        ),
      ])
    })

    await Promise.all(promises)
  }

  /**
   * Flush usage records to analytics
   */
  public async flushUsageRecords(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    // initialize the storage provider
    const usageRecords = await this.storage.getAllUsageRecords()

    if (usageRecords.err) {
      this.logger.error("Failed to get usage records", { error: usageRecords.err.message })
      throw usageRecords.err
    }

    const result = await this.sendUsageRecordsToAnalytics({
      usageRecords: usageRecords.val,
    })

    if (result.err) {
      this.logger.error("Failed to send usage records to analytics", { error: result.err.message })
      throw result.err
    }

    await this.storage.deleteAllUsageRecords()

    return Ok(undefined)
  }

  /**
   * Flush verifications to analytics
   */
  public async flushVerifications(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    const verifications = await this.storage.getAllVerifications()

    if (verifications.err) {
      this.logger.error("Failed to get verifications", { error: verifications.err.message })
      throw verifications.err
    }

    const result = await this.sendVerificationsToAnalytics({
      verifications: verifications.val,
    })

    if (result.err) {
      this.logger.error("Failed to send verifications to analytics", { error: result.err.message })
      throw result.err
    }

    await this.storage.deleteAllVerifications()

    return Ok(undefined)
  }

  /**
   * Invalidate cache (force refresh from DB)
   */
  public async invalidateEntitlements(params: {
    customerId: string
    projectId: string
    featureSlug?: string
  }): Promise<void> {
    const { customerId, projectId, featureSlug } = params

    // flush buffered records first
    const verificationsResult = await this.flushVerifications()
    const usageRecordsResult = await this.flushUsageRecords()

    if (verificationsResult.err) {
      this.logger.error("Failed to flush verifications", { error: verificationsResult.err.message })
      throw verificationsResult.err
    }

    if (usageRecordsResult.err) {
      this.logger.error("Failed to flush usage records", { error: usageRecordsResult.err.message })
      throw usageRecordsResult.err
    }

    if (featureSlug) {
      // delete the entitlement from the storage
      await this.storage.delete({
        customerId,
        projectId,
        featureSlug,
      })

      // delete the entitlement from the cache in background
      await this.cache.customerEntitlement.remove(
        this.makeEntitlementKey({
          customerId,
          projectId,
          featureSlug,
        })
      )
    } else {
      // get all the entitlements from the storage
      const { val: entitlements, err: entitlementsErr } = await this.storage.getAll()

      if (entitlementsErr) {
        this.logger.error("Failed to get entitlements", { error: entitlementsErr.message })
        throw entitlementsErr
      }

      // delete all the entitlements from the storage
      await this.storage.deleteAll()

      // delete the entitlement from the cache in background
      Promise.all(
        entitlements.map((entitlement) =>
          this.cache.customerEntitlement.remove(
            this.makeEntitlementKey({
              customerId: entitlement.customerId,
              projectId: entitlement.projectId,
              featureSlug: entitlement.featureSlug,
            })
          )
        )
      )
    }
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
    now: number
    skipCache?: boolean
  }): Promise<EntitlementState | null> {
    // get the entitlement from the storage
    // this is tier storage to get the entitlement from memory and if missed from kv storage
    const { val: cached } = await this.storage.get(params)

    // cache miss - load from DB or cache if skipCache is true
    if (!cached) {
      this.logger.debug("Cache miss, loading from DB", params)

      // get the entitlement from cache - if not found in cache it will load from DB
      const { val, err } = await this.getActiveEntitlement({
        ...params,
        opts: {
          skipCache: params.skipCache,
        },
      })

      if (err) {
        return null
      }

      // set storage
      // TODO:  we need to check the real usage
      await this.storage.set({ state: val })

      return val
    }

    // if already experied we need to reload the entitlement
    if (cached.expiresAt && params.now >= cached.expiresAt) {
      this.logger.info("Current cycle ended, recomputing grants", params)

      // get the real usage from the storage
      const usageOverrides = {
        [params.featureSlug]: {
          currentCycleUsage: cached.currentCycleUsage,
          accumulatedUsage: cached.accumulatedUsage,
        },
      }

      const result = await this.grantsManager.computeGrantsForCustomer({
        customerId: params.customerId,
        projectId: params.projectId,
        now: params.now,
        usageOverrides,
        featureSlug: params.featureSlug,
      })

      if (result.err) {
        this.logger.error("Failed to recompute grants after cycle reset", {
          error: result.err.message,
          ...params,
        })

        // invalidate the entitlement
        await this.invalidateEntitlements({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
        })

        return null
      }

      // get entitlements from the result
      const entitlement = result.val.find((e) => e.featureSlug === params.featureSlug)

      if (!entitlement) {
        this.logger.warn("Failed to find entitlement after cycle reset", {
          error: "Entitlement not found after cycle reset",
          ...params,
        })

        // invalidate the entitlement
        await this.invalidateEntitlements({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
        })

        return null
      }

      // set storage
      await this.storage.set({ state: entitlement })

      return entitlement
    }

    // Cache hit - no cycle boundary crossed, check if we need to revalidate
    if (params.now >= cached.nextRevalidateAt) {
      this.logger.info("Revalidation time, checking version", params)

      // Lightweight version check (just query version number)
      const { val: entitlement, err } = await this.getActiveEntitlement({
        ...params,
        opts: {
          skipCache: params.skipCache,
        },
      })

      if (err) {
        this.logger.error("Failed to get entitlement from DB", {
          error: err.message,
          ...params,
        })

        // invalidate the entitlement
        await this.invalidateEntitlements({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
        })

        return null
      }

      // no version found, entitlement deleted
      if (!entitlement) {
        // Entitlement deleted, invalidate cache
        await this.invalidateEntitlements({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
        })

        return null
      }

      // Version mismatch or snapshot updated - reload
      // entitlement was recomputed with changes in grants
      if (entitlement.version !== cached.version) {
        this.logger.warn("Version mismatch detected, reloading", {
          ...params,
          cachedVersion: cached.version,
          dbVersion: entitlement.version,
        })

        // reload the entitlement from cache
        const { val: entitlementFromDB, err } = await this.getActiveEntitlement({
          ...params,
          opts: {
            skipCache: true,
          },
        })

        if (err) {
          this.logger.error("Failed to reload entitlement from cache", {
            error: err.message,
            ...params,
          })

          // invalidate the entitlement
          await this.invalidateEntitlements({
            customerId: params.customerId,
            projectId: params.projectId,
            featureSlug: params.featureSlug,
          })

          return null
        }

        // Merge: Use DB for definitions (grants, limits, version, etc.) but cached storage for usage (source of truth)
        // DB has stale usage, but storage has real-time usage
        const mergedEntitlement: EntitlementState = {
          ...entitlementFromDB,
          currentCycleUsage: cached.currentCycleUsage,
          accumulatedUsage: cached.accumulatedUsage,
          effectiveAt: cached.effectiveAt, // May have been updated by normalizeCycleUsage
          expiresAt: cached.expiresAt,
        }

        // set storage
        await this.storage.set({ state: mergedEntitlement })

        // sync the entitlement to db in background
        this.waitUntil(this.syncToDB(mergedEntitlement))

        return cached
      }

      // Version matches - just update revalidation time
      cached.nextRevalidateAt = params.now + this.revalidateInterval
      await this.storage.set({ state: cached })

      // Update cache
      this.waitUntil(this.cache.customerEntitlement.set(this.makeEntitlementKey(params), cached))
    }

    return cached
  }

  /**
   * Make entitlement key
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param featureSlug - Feature slug
   * @returns Entitlement key
   */
  private makeEntitlementKey({
    customerId,
    projectId,
    featureSlug,
  }: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `${projectId}:${customerId}:${featureSlug}`
  }

  /**
   * Sync usage back to DB (async, non-blocking)
   */
  public async syncToDB(state: EntitlementState): Promise<void> {
    const now = Date.now()

    // sync to db if the last sync was more than the sync to db interval
    if (now - state.lastSyncAt < this.syncToDBInterval) {
      return
    }

    this.logger.info("Syncing entitlement to DB", {
      customerId: state.customerId,
      projectId: state.projectId,
      featureSlug: state.featureSlug,
      now,
      lastSyncAt: state.lastSyncAt,
      syncToDBInterval: this.syncToDBInterval,
      usage: state.currentCycleUsage,
    })

    const key = this.makeEntitlementKey({
      customerId: state.customerId,
      projectId: state.projectId,
      featureSlug: state.featureSlug,
    })

    const updated = await this.db
      .update(entitlements)
      .set({
        currentCycleUsage: state.currentCycleUsage.toString(),
        lastSyncAt: now,
      })
      .where(and(eq(entitlements.id, state.id), eq(entitlements.projectId, state.projectId)))
      .returning()
      .then((res) => res[0])

    if (!updated) {
      return
    }

    // Update cache
    await this.cache.customerEntitlement.set(key, updated)
    // update state last sync time
    await this.storage.set({ state: { ...state, lastSyncAt: now } })
  }

  /**
   * Load full entitlement from DB
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param featureSlug - Feature slug
   * @param now - Current time
   * @returns Entitlement state
   */
  private async getActiveEntitlementFromDB({
    customerId,
    projectId,
    featureSlug,
  }: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<EntitlementState | null> {
    const entitlement = await this.db.query.entitlements.findFirst({
      where: (e, { and, eq }) =>
        and(
          eq(e.customerId, customerId),
          eq(e.projectId, projectId),
          eq(e.featureSlug, featureSlug)
        ),
    })

    if (!entitlement) return null

    const state: EntitlementState = {
      id: entitlement.id,
      customerId: entitlement.customerId,
      resetConfig: entitlement.resetConfig,
      mergingPolicy: entitlement.mergingPolicy,
      aggregationMethod: entitlement.aggregationMethod,
      projectId: entitlement.projectId,
      featureSlug: entitlement.featureSlug,
      featureType: entitlement.featureType,
      currentCycleUsage: entitlement.currentCycleUsage,
      accumulatedUsage: entitlement.accumulatedUsage,
      limit: entitlement.limit,
      allowOverage: entitlement.allowOverage,
      grants: entitlement.grants,
      version: entitlement.version,
      lastSyncAt: entitlement.lastSyncAt,
      nextRevalidateAt: entitlement.nextRevalidateAt,
      computedAt: entitlement.computedAt,
      effectiveAt: entitlement.effectiveAt,
      expiresAt: entitlement.expiresAt,
    }

    return state
  }

  /**
   * Get active entitlements for a customer
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param now - Current time
   * @param opts - Options
   * @returns Active entitlements
   */
  public async getActiveEntitlement({
    customerId,
    projectId,
    featureSlug,
    opts,
  }: {
    customerId: string
    projectId: string
    featureSlug: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<EntitlementState, FetchError | UnPriceEntitlementError>> {
    const cacheKey = this.makeEntitlementKey({
      customerId,
      projectId,
      featureSlug,
    })

    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getActiveEntitlement and loading from DB", {
        customerId,
        projectId,
        featureSlug,
      })
    }

    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getActiveEntitlementFromDB({
            customerId,
            projectId,
            featureSlug,
          }),
          (err) =>
            new FetchError({
              message: `unable to query entitlement from db in getActiveEntitlementFromDB - ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                projectId: projectId,
                featureSlug: featureSlug,
                method: "getActiveEntitlementFromDB",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerEntitlement.swr(cacheKey, () =>
              this.getActiveEntitlementFromDB({
                customerId,
                projectId,
                featureSlug,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch entitlement data from cache, retrying...", {
              customerId: customerId,
              featureSlug,
              projectId: projectId,
              method: "getActiveEntitlementFromDB",
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    // set the cache
    this.waitUntil(this.cache.customerEntitlement.set(cacheKey, val ?? null))

    if (!val) {
      return Err(
        new UnPriceEntitlementError({
          message: "entitlement not found",
        })
      )
    }

    return Ok(val)
  }

  /**
   * Get active entitlements for a customer from the source of truth
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param now - Current time
   * @returns Active entitlements
   */
  public async getActiveEntitlements({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<
    Result<EntitlementState[], UnPriceEntitlementError | UnPriceEntitlementStorageError>
  > {
    // 1. Get current usage state from storage (Source of Truth for Usage)
    const { val: storedEntitlements, err: storageErr } = await this.storage.getAll()

    if (storageErr) {
      this.logger.error("Failed to get entitlements from storage", { error: storageErr.message })
      return Err(storageErr)
    }

    // Map stored usage to overrides
    const usageOverrides: Record<string, { currentCycleUsage: string; accumulatedUsage: string }> =
      {}

    if (storedEntitlements && storedEntitlements.length > 0) {
      for (const e of storedEntitlements) {
        usageOverrides[e.featureSlug] = {
          currentCycleUsage: e.currentCycleUsage,
          accumulatedUsage: e.accumulatedUsage,
        }
      }
    }

    // 2. Compute correct entitlement definitions from DB (Source of Truth for Definitions)
    // This ensures we:
    // a) Get new features added to the plan/grants
    // b) Remove features that were revoked
    // c) Preserve usage from storage via overrides
    const { val: computedEntitlements, err: computeErr } =
      await this.grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
        usageOverrides,
      })

    if (computeErr) {
      this.logger.error("Failed to compute grants", { error: computeErr.message })
      // Fallback to storage if DB computation fails, to ensure availability
      if (storedEntitlements && storedEntitlements.length > 0) {
        this.logger.warn("Falling back to stored entitlements", {
          customerId,
          projectId,
          count: storedEntitlements.length,
        })
        return Ok(storedEntitlements)
      }
      return Err(
        new UnPriceEntitlementError({
          message: computeErr.message,
        })
      )
    }

    // 3. Update storage with the fresh authoritative state
    // We update in parallel to be efficient
    await Promise.all(computedEntitlements.map((e) => this.storage.set({ state: e })))

    // 4. Remove entitlements that are no longer active
    if (storedEntitlements) {
      const computedSlugs = new Set(computedEntitlements.map((e) => e.featureSlug))
      const toRemove = storedEntitlements.filter((e) => !computedSlugs.has(e.featureSlug))
      if (toRemove.length > 0) {
        // invalidate the entitlements
        // it removes them from storage and cache but sending any buffered records to analytics
        this.waitUntil(
          Promise.all(
            toRemove.map((e) =>
              this.invalidateEntitlements({
                customerId: e.customerId,
                projectId: e.projectId,
                featureSlug: e.featureSlug,
              })
            )
          )
        )
      }
    }

    return Ok(computedEntitlements)
  }

  /**
   * Get current usage for a customer
   */
  public async getCurrentUsage({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<CurrentUsage, UnPriceEntitlementError | UnPriceEntitlementStorageError>> {
    // Get grants and subscription info
    const grantsResult = await this.grantsManager.getGrantsForCustomer({
      customerId,
      projectId,
      now,
    })

    if (grantsResult.err) {
      return Err(new UnPriceEntitlementError({ message: grantsResult.err.message }))
    }

    const { grants, subscription, planVersion } = grantsResult.val

    if (grants.length === 0 || !subscription || !planVersion) {
      return Ok(this.buildEmptyUsageResponse(planVersion?.currency ?? "USD"))
    }

    // Compute entitlement states and get usage estimates in parallel
    const [entitlementsResult, usageEstimatesResult] = await Promise.all([
      this.computeEntitlementStates(grants),
      this.getUsageEstimates(customerId, projectId, now),
    ])

    if (entitlementsResult.err) {
      return Err(entitlementsResult.err)
    }

    if (usageEstimatesResult.err) {
      return Err(usageEstimatesResult.err)
    }

    // Build feature map and process features
    const featureMap = new Map(
      grants.map((g) => [g.featurePlanVersion.feature.slug, g.featurePlanVersion])
    )

    const features = this.buildFeatures(
      entitlementsResult.val,
      usageEstimatesResult.val,
      featureMap
    )

    if (features.length === 0) {
      return Ok(this.buildEmptyUsageResponse(planVersion.currency))
    }

    // Build and return response
    return Ok(
      this.buildUsageResponse(
        features,
        subscription,
        planVersion,
        subscription.currentCycleEndAt,
        usageEstimatesResult.val
      )
    )
  }

  private buildEmptyUsageResponse(currency: string): CurrentUsage {
    return {
      planName: "No Plan",
      basePrice: formatMoney("0", currency),
      billingPeriod: "monthly",
      billingPeriodLabel: "mo",
      currency,
      groups: [],
      priceSummary: {
        totalPrice: formatMoney("0", currency),
        basePrice: formatMoney("0", currency),
        usageCharges: formatMoney("0", currency),
        hasUsageCharges: false,
        flatTotal: formatMoney("0", currency),
        tieredTotal: formatMoney("0", currency),
        packageTotal: formatMoney("0", currency),
        usageTotal: formatMoney("0", currency),
      },
    }
  }

  private async computeEntitlementStates(
    grants: NonNullable<
      Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
    >["grants"]
  ): Promise<Result<Omit<EntitlementState, "id">[], UnPriceEntitlementError>> {
    // Group grants by feature slug
    const grantsByFeature = new Map<string, typeof grants>()
    for (const grant of grants) {
      const slug = grant.featurePlanVersion.feature.slug
      const existing = grantsByFeature.get(slug) ?? []
      grantsByFeature.set(slug, [...existing, grant])
    }

    // Compute entitlement states for all features in parallel
    const entitlementPromises = Array.from(grantsByFeature.values()).map((featureGrants) =>
      this.grantsManager.computeEntitlementState({ grants: featureGrants })
    )

    const results = await Promise.all(entitlementPromises)

    // Check for errors and collect entitlements
    const entitlements: Omit<EntitlementState, "id">[] = []
    for (const result of results) {
      if (result.err) {
        return Err(new UnPriceEntitlementError({ message: result.err.message }))
      }
      entitlements.push(result.val)
    }

    return Ok(entitlements)
  }

  private async getUsageEstimates(
    customerId: string,
    projectId: string,
    now: number
  ): Promise<
    Result<
      Awaited<ReturnType<BillingService["estimatePriceCurrentUsage"]>>["val"],
      UnPriceEntitlementError
    >
  > {
    const billingService = new BillingService({
      db: this.db,
      logger: this.logger,
      analytics: this.analytics,
      waitUntil: this.waitUntil,
      cache: this.cache,
      metrics: this.metrics,
    })

    const result = await billingService.estimatePriceCurrentUsage({
      customerId,
      projectId,
      now,
    })

    return result.err
      ? Err(new UnPriceEntitlementError({ message: result.err.message }))
      : Ok(result.val)
  }

  private buildFeatures(
    entitlements: Omit<EntitlementState, "id">[],
    usageEstimates: Awaited<ReturnType<BillingService["estimatePriceCurrentUsage"]>>["val"],
    featureMap: Map<
      string,
      NonNullable<
        Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
      >["grants"][number]["featurePlanVersion"]
    >
  ) {
    const grantIds = new Set(usageEstimates?.map((u) => u.grantId) ?? [])

    return entitlements
      .map((entitlement) => {
        const planVersionFeature = featureMap.get(entitlement.featureSlug)
        if (!planVersionFeature) return null

        // Find matching usage estimates by grant ID
        const usageGrants = (usageEstimates ?? []).filter((u) =>
          entitlement.grants.some((g) => g.id === u.grantId && grantIds.has(u.grantId ?? ""))
        )

        // Aggregate usage data
        const usage = usageGrants.reduce((acc, u) => acc + u.usage, 0)
        const included = usageGrants.reduce((acc, u) => acc + u.included, 0)
        // Sum prices from usageEstimates (already formatted strings, need to parse to sum)
        const priceNum = usageGrants.reduce(
          (acc, u) => acc + Number.parseFloat(u.totalPrice?.replace(/[^0-9.-]/g, "") ?? "0"),
          0
        )

        return {
          entitlement,
          planVersionFeature,
          usage,
          included,
          priceNum, // Keep as number for calculations, will format later
          limit: entitlement.limit,
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
  }

  private buildUsageResponse(
    features: ReturnType<typeof this.buildFeatures>,
    subscription: NonNullable<
      NonNullable<
        Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
      >["subscription"]
    >,
    planVersion: NonNullable<
      NonNullable<
        Awaited<ReturnType<typeof this.grantsManager.getGrantsForCustomer>>["val"]
      >["planVersion"]
    >,
    cycleEndAt: number,
    usageEstimates: Awaited<ReturnType<BillingService["estimatePriceCurrentUsage"]>>["val"]
  ): CurrentUsage {
    const billingConfig = planVersion.billingConfig
    const billingPeriod = billingConfig.name
    const currency = planVersion.currency

    // Calculate base price
    const pricePlanResult = calculateFlatPricePlan({
      planVersion: {
        ...planVersion,
        planFeatures: features.map((f) => f.planVersionFeature),
      },
    })

    if (pricePlanResult.err) {
      throw pricePlanResult.err
    }

    // Use displayAmount directly as string (already formatted with currency)
    const basePrice = pricePlanResult.val.displayAmount
    const basePriceDinero = pricePlanResult.val.dinero

    // Format renewal date
    const date = toZonedTime(new Date(cycleEndAt), subscription.timezone)
    const renewalDate =
      billingConfig.billingInterval === "minute"
        ? format(date, "MMMM d, yyyy hh:mm a")
        : format(date, "MMMM d, yyyy")

    const daysRemaining = Math.ceil((cycleEndAt - Date.now()) / (1000 * 60 * 60 * 24))

    // Build feature displays
    const displayFeatures = features.map((f) =>
      this.buildFeatureDisplay(f, billingConfig, currency)
    )

    // Use prices directly from usageEstimates using dinero objects
    // Group by feature type by matching grants to features
    const grantToFeatureType = new Map<string, string>()
    for (const feature of features) {
      for (const grant of feature.entitlement.grants) {
        grantToFeatureType.set(grant.id, feature.entitlement.featureType)
      }
    }

    // Initialize dinero totals with zero (using basePrice currency)
    const zeroDinero = dinero({ amount: 0, currency: basePriceDinero.toJSON().currency })
    let flatTotalDinero: Dinero<number> = zeroDinero
    let tieredTotalDinero: Dinero<number> = zeroDinero
    let usageTotalDinero: Dinero<number> = zeroDinero
    let packageTotalDinero: Dinero<number> = zeroDinero

    // Sum prices from usageEstimates by feature type using dinero
    for (const estimate of usageEstimates ?? []) {
      if (!estimate.grantId || !estimate.totalPriceDinero) continue
      const featureType = grantToFeatureType.get(estimate.grantId)
      if (!featureType) continue

      if (featureType === "flat") {
        flatTotalDinero = add(flatTotalDinero, estimate.totalPriceDinero)
      } else if (featureType === "tier") {
        tieredTotalDinero = add(tieredTotalDinero, estimate.totalPriceDinero)
      } else if (featureType === "usage") {
        usageTotalDinero = add(usageTotalDinero, estimate.totalPriceDinero)
      } else if (featureType === "package") {
        packageTotalDinero = add(packageTotalDinero, estimate.totalPriceDinero)
      }
    }

    // Calculate usageCharges by summing all non-package totals
    const usageChargesDinero = add(tieredTotalDinero, usageTotalDinero)

    // Calculate total price using dinero
    const totalPriceDinero = add(basePriceDinero, usageChargesDinero)

    // Format prices from dinero (basePrice is already formatted, so we only format the totals)
    const flatTotal = toDecimal(flatTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const tieredTotal = toDecimal(tieredTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const usageTotal = toDecimal(usageTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const packageTotal = toDecimal(packageTotalDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const usageCharges = toDecimal(usageChargesDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )
    const totalPrice = toDecimal(totalPriceDinero, ({ value, currency }) =>
      formatMoney(value.toString(), currency.code)
    )

    return {
      planName: subscription.planSlug ?? "No Plan",
      planDescription: planVersion.description ?? undefined,
      basePrice,
      billingPeriod,
      billingPeriodLabel: billingPeriod,
      currency,
      renewalDate,
      daysRemaining: daysRemaining > 0 ? daysRemaining : undefined,
      groups: [
        {
          id: "all-features",
          name: "Features",
          featureCount: features.length,
          features: displayFeatures,
          totalPrice: usageCharges,
        },
      ],
      priceSummary: {
        totalPrice,
        basePrice,
        usageCharges,
        hasUsageCharges: usageChargesDinero.toJSON().amount > 0,
        flatTotal,
        tieredTotal,
        packageTotal,
        usageTotal,
      },
    }
  }

  private buildFeatureDisplay(
    feature: NonNullable<ReturnType<typeof this.buildFeatures>[number]>,
    billingConfig: { billingInterval?: string; currency?: string },
    currency: string
  ): CurrentUsage["groups"][number]["features"][number] {
    const { entitlement, planVersionFeature, usage, included, priceNum, limit } = feature
    const featureType = entitlement.featureType
    const billingInterval = billingConfig?.billingInterval ?? "month"
    const hasDifferentBilling = billingInterval !== "month"

    // Format price as string (price comes from usageEstimates)
    const priceString = formatMoney(priceNum.toString(), currency)

    const baseFeature = {
      id: entitlement.featureSlug,
      name: planVersionFeature.feature.title ?? entitlement.featureSlug,
      description: planVersionFeature.feature.description ?? undefined,
      currency,
      price: priceString,
      isIncluded: feature.priceNum === 0,
    }

    const billingFrequency = hasDifferentBilling
      ? (billingInterval as "daily" | "weekly" | "monthly" | "yearly")
      : undefined

    if (featureType === "flat") {
      return {
        ...baseFeature,
        type: "flat" as const,
        typeLabel: "Flat",
        enabled: (limit ?? 0) > 0,
        billing: {
          hasDifferentBilling,
          billingFrequency,
          billingFrequencyLabel: billingFrequency,
          resetFrequency: undefined,
          resetFrequencyLabel: undefined,
        },
      }
    }

    if (featureType === "tier") {
      const config = planVersionFeature.config as { tiers?: Array<unknown> } | undefined
      const tiers =
        (config?.tiers as Array<{
          firstUnit: number
          lastUnit: number | null
          unitPrice: { displayAmount: string }
          label?: string
        }>) ?? []

      const formattedTiers = tiers.map((tier, index) => ({
        min: tier.firstUnit,
        max: tier.lastUnit,
        pricePerUnit: Number.parseFloat(tier.unitPrice?.displayAmount ?? "0"),
        label: tier.label ?? `Tier ${index + 1}`,
        isActive: usage >= tier.firstUnit && (tier.lastUnit === null || usage <= tier.lastUnit),
      }))

      return {
        ...baseFeature,
        type: "tiered" as const,
        typeLabel: "Tiered",
        billing: { hasDifferentBilling: false },
        tieredDisplay: {
          currentUsage: usage,
          billableUsage: Math.max(0, usage - included),
          unit: planVersionFeature.feature.unit ?? "units",
          freeAmount: included,
          tiers: formattedTiers,
          currentTierLabel: formattedTiers.find((t) => t.isActive)?.label,
        },
      }
    }

    // Usage type
    const limitType: "hard" | "soft" | "none" =
      limit === null ? "none" : planVersionFeature.allowOverage ? "soft" : "hard"

    return {
      ...baseFeature,
      type: "usage" as const,
      typeLabel: "Usage",
      billing: {
        hasDifferentBilling,
        billingFrequency,
        billingFrequencyLabel: billingFrequency,
        resetFrequency: undefined,
        resetFrequencyLabel: undefined,
      },
      usageBar: {
        current: usage,
        included,
        limit: limit ?? undefined,
        limitType,
        unit: planVersionFeature.feature.unit ?? "units",
        notifyThreshold: planVersionFeature.notifyUsageThreshold ?? 95,
        allowOverage: planVersionFeature.allowOverage,
      },
    }
  }
}
