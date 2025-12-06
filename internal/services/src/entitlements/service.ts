import type { Analytics, AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { and, eq } from "@unprice/db"
import { entitlements } from "@unprice/db/schema"
import type {
  CurrentUsage,
  EntitlementState,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logging"
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
      await this.storage.set({ state: val })

      return val
    }

    // if already experied we need to reload the entitlement
    if (cached.expiresAt && params.now >= cached.expiresAt) {
      this.logger.info("Current cycle ended, recomputing grants", params)

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

        // set storage
        await this.storage.set({ state: entitlementFromDB })

        return entitlementFromDB
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
    // sync to db if the last sync was more than the sync to db interval
    if (Date.now() - state.lastSyncAt < this.syncToDBInterval) {
      return
    }

    const key = this.makeEntitlementKey({
      customerId: state.customerId,
      projectId: state.projectId,
      featureSlug: state.featureSlug,
    })

    const now = Date.now()

    // Prevent multiple syncs within 1 second to avoid DB flooding (primary check)
    if (now - state.lastSyncAt < 1000) {
      return
    }

    // Check if enough time has passed since last sync (secondary check)
    if (now - state.lastSyncAt < this.syncToDBInterval) {
      return
    }

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
    // Get customer's subscription to find planVersion
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
                    planFeatures: {
                      with: {
                        feature: true,
                      },
                    },
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
        new UnPriceEntitlementError({
          message: "Customer not found",
        })
      )
    }

    const subscription = customerSubscription.subscriptions[0]
    if (!subscription) {
      return Err(
        new UnPriceEntitlementError({
          message: "No subscription found for customer",
        })
      )
    }

    const phase = subscription.phases[0]
    if (!phase || !phase.planVersion) {
      return Err(
        new UnPriceEntitlementError({
          message: "No active phase or plan version found",
        })
      )
    }

    // Compute grants for customer
    const { val: entitlements, err: entitlementsErr } =
      await this.grantsManager.computeGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

    if (entitlementsErr) {
      return Err(
        new UnPriceEntitlementError({
          message: entitlementsErr.message,
        })
      )
    }

    // Get current usage estimates from billing service
    const billingService = new BillingService({
      db: this.db,
      logger: this.logger,
      analytics: this.analytics,
      waitUntil: this.waitUntil,
      cache: this.cache,
      metrics: this.metrics,
    })

    const { val: currentUsageEstimates, err: currentUsageErr } =
      await billingService.estimatePriceCurrentUsage({
        customerId,
        projectId,
        now,
      })

    if (currentUsageErr) {
      return Err(currentUsageErr)
    }

    // Build feature map from planFeatures
    const featureMap = new Map(phase.planVersion.planFeatures.map((f) => [f.feature.slug, f]))

    const entitlementResults = []

    // Consolidate usage by entitlement
    for (const entitlement of entitlements) {
      const currentUsageGrants = currentUsageEstimates.filter((u) =>
        entitlement.grants.some((g) => g.id === u.grantId)
      )

      const totalUsage = currentUsageGrants.reduce((acc, u) => acc + u.usage, 0) ?? 0
      const totalFreeUnits = currentUsageGrants.reduce((acc, u) => acc + u.freeUnits, 0) ?? 0
      const totalIncluded = currentUsageGrants.reduce((acc, u) => acc + u.included, 0) ?? 0
      const totalMax = currentUsageGrants.reduce((acc, u) => acc + u.max, 0) ?? 0
      const totalPrice = currentUsageGrants.reduce(
        (acc, u) => acc + Number.parseFloat(u.totalPrice ?? "0"),
        0
      )

      const planVersionFeature = featureMap.get(entitlement.featureSlug)
      if (!planVersionFeature) {
        continue
      }

      entitlementResults.push({
        featureSlug: entitlement.featureSlug,
        featureType: entitlement.featureType,
        limit: entitlement.limit,
        usage: totalUsage,
        freeUnits: totalFreeUnits,
        included: totalIncluded,
        max: totalMax,
        units: entitlement.limit,
        price: totalPrice > 0 ? totalPrice.toString() : null,
        featureVersion: {
          id: planVersionFeature.id,
          projectId: planVersionFeature.projectId,
          createdAtM: planVersionFeature.createdAtM,
          updatedAtM: planVersionFeature.updatedAtM,
          planVersionId: planVersionFeature.planVersionId,
          type: planVersionFeature.type,
          featureId: planVersionFeature.featureId,
          featureType: planVersionFeature.featureType,
          config: planVersionFeature.config,
          billingConfig: planVersionFeature.billingConfig,
          resetConfig: planVersionFeature.resetConfig,
          metadata: planVersionFeature.metadata,
          aggregationMethod: planVersionFeature.aggregationMethod,
          order: planVersionFeature.order,
          defaultQuantity: planVersionFeature.defaultQuantity,
          limit: planVersionFeature.limit,
          allowOverage: planVersionFeature.allowOverage,
          notifyUsageThreshold: planVersionFeature.notifyUsageThreshold,
          hidden: planVersionFeature.hidden,
          feature: {
            id: planVersionFeature.feature.id,
            projectId: planVersionFeature.feature.projectId,
            createdAtM: planVersionFeature.feature.createdAtM,
            updatedAtM: planVersionFeature.feature.updatedAtM,
            slug: planVersionFeature.feature.slug,
            code: planVersionFeature.feature.code,
            unit: planVersionFeature.feature.unit,
            title: planVersionFeature.feature.title,
            description: planVersionFeature.feature.description,
          },
        },
      })
    }

    if (!entitlementResults.length) {
      return Ok({
        planName: "No Plan",
        basePrice: 0,
        billingPeriod: "monthly",
        billingPeriodLabel: "mo",
        currency: "USD",
        groups: [],
        priceSummary: {
          totalPrice: 0,
          basePrice: 0,
          usageCharges: 0,
          hasUsageCharges: false,
          flatTotal: 0,
          tieredTotal: 0,
          usageTotal: 0,
          freeGrantsSavings: 0,
          hasFreeGrantsSavings: false,
        },
      })
    }

    const usageData = {
      planVersion: {
        description: phase.planVersion.description,
        flatPrice: "0",
        currentTotalPrice: "0",
        billingConfig: phase.planVersion.billingConfig,
        resetConfig: phase.planVersion.planFeatures[0]?.resetConfig ?? {
          name: "default",
          resetInterval: phase.planVersion.billingConfig.billingInterval,
          resetIntervalCount: phase.planVersion.billingConfig.billingIntervalCount,
          resetAnchor: phase.planVersion.billingConfig.billingAnchor,
          planType: phase.planVersion.billingConfig.planType,
        },
        allowOverage: phase.planVersion.planFeatures[0]?.allowOverage ?? false,
        notifyUsageThreshold: phase.planVersion.planFeatures[0]?.notifyUsageThreshold ?? 95,
        type: phase.planVersion.planFeatures[0]?.type ?? "feature",
      },
      subscription: {
        planSlug: subscription.planSlug,
        status: subscription.status,
        currentCycleEndAt: subscription.currentCycleEndAt,
        timezone: subscription.timezone,
        currentCycleStartAt: subscription.currentCycleStartAt,
        prorationFactor: 0,
        prorated: false,
      },
      phase: {
        trialEndsAt: phase.trialEndsAt,
        endAt: phase.endAt,
        trialUnits: phase.trialUnits,
        isTrial: phase.trialEndsAt !== null && phase.trialEndsAt > now,
      },
      entitlement: entitlementResults,
    }

    if (!usageData.planVersion || !usageData.subscription || !usageData.entitlement) {
      return Ok({
        planName: "No Plan",
        basePrice: 0,
        billingPeriod: "monthly",
        billingPeriodLabel: "mo",
        currency: "USD",
        groups: [],
        priceSummary: {
          totalPrice: 0,
          basePrice: 0,
          usageCharges: 0,
          hasUsageCharges: false,
          flatTotal: 0,
          tieredTotal: 0,
          usageTotal: 0,
          freeGrantsSavings: 0,
          hasFreeGrantsSavings: false,
        },
      })
    }

    // Helper function to format frequency
    const formatFrequency = (freq: "daily" | "weekly" | "monthly" | "yearly"): string => {
      const labels: Record<"daily" | "weekly" | "monthly" | "yearly", string> = {
        daily: "day",
        weekly: "week",
        monthly: "mo",
        yearly: "yr",
      }
      return labels[freq]
    }

    // Helper to calculate percentages
    const calculatePercentages = (
      current: number,
      included: number,
      limit: number | null,
      freeAmount: number
    ) => {
      const maxValue = limit ?? included
      const limitPercent = 100
      const currentPercent = maxValue > 0 ? Math.min(100, (current / maxValue) * 100) : 0
      const includedPercent = maxValue > 0 ? Math.min(100, (included / maxValue) * 100) : 0
      const freePercent = maxValue > 0 ? Math.min(100, (freeAmount / maxValue) * 100) : 0

      return { currentPercent, includedPercent, freePercent, limitPercent }
    }

    // Type for entitlement item
    type EntitlementItem = NonNullable<typeof usageData>["entitlement"][number]

    // Build usage bar display
    const buildUsageBarDisplay = (ent: EntitlementItem) => {
      const feature = ent.featureVersion?.feature
      const unit = feature?.unit ?? "units"
      const usage = ent.usage ?? 0
      const included = ent.included ?? 0
      const limit = ent.limit
      const freeUnits = ent.freeUnits ?? 0
      const price = Number.parseFloat(ent.price ?? "0")
      const planVersionFeature = ent.featureVersion
      const allowOverage = planVersionFeature?.allowOverage ?? false

      const limitType: "hard" | "soft" | "none" =
        limit === null ? "none" : allowOverage ? "soft" : "hard"

      const { currentPercent, includedPercent, freePercent, limitPercent } = calculatePercentages(
        usage,
        included,
        limit,
        freeUnits
      )

      const isOverIncluded = usage > included
      const isOverLimit = limit !== null && usage > limit
      const notifyThreshold = planVersionFeature?.notifyUsageThreshold ?? 95
      const isNearLimit = limit !== null && currentPercent >= notifyThreshold

      let statusMessage: string | undefined
      let statusType: "warning" | "error" | "info" | undefined

      if (isOverLimit && !allowOverage) {
        statusMessage = "Limit exceeded"
        statusType = "error"
      } else if (isOverIncluded) {
        statusMessage = "Over included limit"
        statusType = "info"
      } else if (isNearLimit) {
        statusMessage = "Near limit"
        statusType = "warning"
      }

      const billableUsage = Math.max(0, usage - included - freeUnits)
      const overageAmount = limit !== null && usage > limit ? usage - limit : 0
      const overageCost = isOverIncluded ? price : 0

      return {
        current: usage,
        included,
        limit: limit ?? undefined,
        limitType,
        unit,
        freeAmount: freeUnits,
        currentPercent,
        includedPercent,
        freePercent,
        limitPercent,
        isOverIncluded,
        isOverLimit,
        isNearLimit,
        statusMessage,
        statusType,
        billableUsage,
        overageAmount,
        overageCost,
      }
    }

    // Build flat feature display
    const buildFlatFeatureDisplay = (ent: EntitlementItem, currency: string) => {
      const feature = ent.featureVersion?.feature
      const price = Number.parseFloat(ent.price ?? "0")
      const planVersionFeature = ent.featureVersion
      const billingConfig = planVersionFeature?.billingConfig as
        | {
            billingInterval?: "month" | "year" | "week" | "day" | "minute" | "onetime"
            [key: string]: unknown
          }
        | undefined
      const resetConfig = planVersionFeature?.resetConfig as
        | {
            resetInterval?: string
            [key: string]: unknown
          }
        | undefined

      const billingInterval = billingConfig?.billingInterval ?? "month"
      const hasDifferentBilling = billingInterval !== "month"

      return {
        id: ent.featureSlug,
        name: feature?.title ?? ent.featureSlug,
        description: feature?.description ? feature.description : undefined,
        type: "flat" as const,
        typeLabel: "Flat",
        currency,
        price,
        isIncluded: price === 0,
        enabled: (ent.units ?? 0) > 0,
        billing: {
          hasDifferentBilling,
          billingFrequency: hasDifferentBilling
            ? ((billingInterval === "day"
                ? "daily"
                : billingInterval === "week"
                  ? "weekly"
                  : billingInterval === "year"
                    ? "yearly"
                    : "monthly") as "daily" | "weekly" | "monthly" | "yearly")
            : undefined,
          billingFrequencyLabel: hasDifferentBilling
            ? formatFrequency(
                billingInterval === "day"
                  ? "daily"
                  : billingInterval === "week"
                    ? "weekly"
                    : billingInterval === "year"
                      ? "yearly"
                      : "monthly"
              )
            : undefined,
          resetFrequency: resetConfig?.resetInterval
            ? ((resetConfig?.resetInterval === "day"
                ? "daily"
                : resetConfig?.resetInterval === "week"
                  ? "weekly"
                  : resetConfig?.resetInterval === "year"
                    ? "yearly"
                    : "monthly") as "daily" | "weekly" | "monthly" | "yearly")
            : undefined,
          resetFrequencyLabel: resetConfig?.resetInterval
            ? formatFrequency(
                resetConfig?.resetInterval === "day"
                  ? "daily"
                  : resetConfig?.resetInterval === "week"
                    ? "weekly"
                    : resetConfig?.resetInterval === "year"
                      ? "yearly"
                      : "monthly"
              )
            : undefined,
        },
      }
    }

    // Build tiered feature display
    const buildTieredFeatureDisplay = (ent: EntitlementItem, currency: string) => {
      const feature = ent.featureVersion?.feature
      const unit = feature?.unit ?? "units"
      const usage = ent.usage ?? 0
      const freeUnits = ent.freeUnits ?? 0
      const price = Number.parseFloat(ent.price ?? "0")
      const planVersionFeature = ent.featureVersion
      const config = planVersionFeature?.config

      const tiers =
        config && typeof config === "object" && "tiers" in config && Array.isArray(config.tiers)
          ? (config.tiers as unknown as Array<{
              firstUnit: number
              lastUnit: number | null
              unitPrice: { displayAmount: string; dinero?: unknown }
              flatPrice: { displayAmount: string; dinero?: unknown }
              label?: string
            }>)
          : []

      const formattedTiers = tiers.map((tier, index) => {
        const isActive =
          usage >= tier.firstUnit && (tier.lastUnit === null || usage <= tier.lastUnit)
        const pricePerUnit = Number.parseFloat(tier.unitPrice?.displayAmount ?? "0")
        return {
          min: tier.firstUnit,
          max: tier.lastUnit,
          pricePerUnit,
          label: tier.label ?? `Tier ${index + 1}`,
          isActive,
        }
      })

      const activeTier = formattedTiers.find((t) => t.isActive)
      const currentTierLabel = activeTier?.label

      const billableUsage = Math.max(0, usage - freeUnits)

      return {
        id: ent.featureSlug,
        name: feature?.title ?? ent.featureSlug,
        description: feature?.description ? feature.description : undefined,
        type: "tiered" as const,
        typeLabel: "Tiered",
        currency,
        price,
        isIncluded: price === 0,
        billing: {
          hasDifferentBilling: false,
        },
        tieredDisplay: {
          currentUsage: usage,
          billableUsage,
          unit,
          freeAmount: freeUnits,
          tiers: formattedTiers.map((tier) => ({
            min: tier.min,
            max: tier.max,
            pricePerUnit: tier.pricePerUnit,
            label: tier.label,
            isActive: tier.isActive,
          })),
          currentTierLabel,
        },
      }
    }

    // Build usage feature display
    const buildUsageFeatureDisplay = (ent: EntitlementItem, currency: string) => {
      const feature = ent.featureVersion?.feature
      const planVersionFeature = ent.featureVersion
      const billingConfig = planVersionFeature?.billingConfig as
        | {
            billingInterval?: "month" | "year" | "week" | "day" | "minute" | "onetime"
            [key: string]: unknown
          }
        | undefined
      const resetConfig = planVersionFeature?.resetConfig as
        | {
            resetInterval?: string
            [key: string]: unknown
          }
        | undefined

      const billingInterval = billingConfig?.billingInterval ?? "month"
      const hasDifferentBilling = billingInterval !== "month"

      const price = Number.parseFloat(ent.price ?? "0")

      return {
        id: ent.featureSlug,
        name: feature?.title ?? ent.featureSlug,
        description: feature?.description ? feature.description : undefined,
        type: "usage" as const,
        typeLabel: "Usage",
        currency,
        price,
        isIncluded: price === 0,
        billing: {
          hasDifferentBilling,
          billingFrequency: hasDifferentBilling
            ? ((billingInterval === "day"
                ? "daily"
                : billingInterval === "week"
                  ? "weekly"
                  : billingInterval === "year"
                    ? "yearly"
                    : "monthly") as "daily" | "weekly" | "monthly" | "yearly")
            : undefined,
          billingFrequencyLabel: hasDifferentBilling
            ? formatFrequency(
                billingInterval === "day"
                  ? "daily"
                  : billingInterval === "week"
                    ? "weekly"
                    : billingInterval === "year"
                      ? "yearly"
                      : "monthly"
              )
            : undefined,
          resetFrequency: resetConfig?.resetInterval
            ? ((resetConfig?.resetInterval === "day"
                ? "daily"
                : resetConfig?.resetInterval === "week"
                  ? "weekly"
                  : resetConfig?.resetInterval === "year"
                    ? "yearly"
                    : "monthly") as "daily" | "weekly" | "monthly" | "yearly")
            : undefined,
          resetFrequencyLabel: resetConfig?.resetInterval
            ? formatFrequency(
                resetConfig?.resetInterval === "day"
                  ? "daily"
                  : resetConfig?.resetInterval === "week"
                    ? "weekly"
                    : resetConfig?.resetInterval === "year"
                      ? "yearly"
                      : "monthly"
              )
            : undefined,
        },
        usageBar: buildUsageBarDisplay(ent),
      }
    }

    // Build feature display based on type
    const buildFeatureDisplay = (ent: EntitlementItem, currency: string) => {
      const featureType = ent.featureType

      switch (featureType) {
        case "flat":
          return buildFlatFeatureDisplay(ent, currency)
        case "tier":
          return buildTieredFeatureDisplay(ent, currency)
        case "usage":
          return buildUsageFeatureDisplay(ent, currency)
        default:
          return buildUsageFeatureDisplay(ent, currency)
      }
    }

    // Build price summary
    const buildPriceSummary = (
      features: ReturnType<typeof buildFeatureDisplay>[],
      basePrice: number
    ) => {
      let flatTotal = 0
      let tieredTotal = 0
      let usageTotal = 0

      for (const feature of features) {
        switch (feature.type) {
          case "flat":
            flatTotal += feature.price
            break
          case "tiered":
            tieredTotal += feature.price
            break
          case "usage":
            usageTotal += feature.price
            break
        }
      }

      const usageCharges = flatTotal + tieredTotal + usageTotal
      const totalPrice = basePrice + usageCharges

      return {
        totalPrice,
        basePrice,
        usageCharges,
        hasUsageCharges: usageCharges > 0,
        flatTotal,
        tieredTotal,
        usageTotal,
        freeGrantsSavings: 0,
        hasFreeGrantsSavings: false,
      }
    }

    // Extract plan info
    const planName = usageData.subscription.planSlug ?? "No Plan"
    const planDescription = usageData.planVersion.description
    const basePrice = Number.parseFloat(usageData.planVersion.flatPrice ?? "0")
    const billingConfig = usageData.planVersion.billingConfig as {
      billingInterval?: "month" | "year" | "week" | "day" | "minute" | "onetime"
      currency?: string
    }
    const billingInterval = billingConfig?.billingInterval ?? "month"
    const billingPeriod = (
      billingInterval === "day"
        ? "daily"
        : billingInterval === "week"
          ? "weekly"
          : billingInterval === "year"
            ? "yearly"
            : "monthly"
    ) as "daily" | "weekly" | "monthly" | "yearly"
    const currency = (billingConfig as { currency?: string } | undefined)?.currency ?? "USD"

    // Calculate renewal date and days remaining
    const renewalDate = new Date(usageData.subscription.currentCycleEndAt)
    const daysRemaining = Math.ceil(
      (usageData.subscription.currentCycleEndAt - Date.now()) / (1000 * 60 * 60 * 24)
    )

    // Transform entitlements to features
    const features = usageData.entitlement
      .filter((e): e is NonNullable<typeof e> => e !== undefined && e !== null)
      .map((e) => buildFeatureDisplay(e, currency))

    // Group features
    const groups = [
      {
        id: "all-features",
        name: "Features",
        featureCount: features.length,
        features,
        totalPrice: features.reduce((sum, f) => sum + f.price, 0),
      },
    ]

    const priceSummary = buildPriceSummary(features, basePrice)

    return Ok({
      planName,
      planDescription: planDescription ?? undefined,
      basePrice,
      billingPeriod,
      billingPeriodLabel: formatFrequency(billingPeriod),
      currency,
      renewalDate: renewalDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      daysRemaining: daysRemaining > 0 ? daysRemaining : undefined,
      groups,
      priceSummary,
    })
  }
}
