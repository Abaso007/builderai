import type { Analytics, AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { and, eq } from "@unprice/db"
import { entitlements } from "@unprice/db/schema"
import type {
  EntitlementState,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logging"
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
        allowed: false,
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        metadata: params.metadata,
        latency: performance.now() - params.performanceStart,
        entitlementId: "",
        requestId: params.requestId,
        createdAt: Date.now(),
      })

      return {
        allowed: false,
        message: "No entitlement found",
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        usage: 0,
        limit: undefined,
      }
    }

    const result = this.grantsManager.verify({ state, now: params.timestamp })

    // Insert verification record
    await this.storage.insertVerification({
      customerId: params.customerId,
      projectId: params.projectId,
      featureSlug: params.featureSlug,
      timestamp: params.timestamp,
      allowed: result.allowed,
      deniedReason: result.deniedReason ?? undefined,
      metadata: params.metadata,
      latency: performance.now() - params.performanceStart,
      entitlementId: state.id,
      requestId: params.requestId,
      createdAt: Date.now(),
    })

    return result
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
        message: "No entitlement found",
        deniedReason: "ENTITLEMENT_NOT_FOUND",
        usage: 0,
        limit: undefined,
        consumedFrom: [],
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
      state.currentCycleUsage = result.usage?.toString() ?? "0"

      if (result.accumulatedUsage) {
        state.accumulatedUsage = result.accumulatedUsage
      }

      if (result.effectiveAt) {
        state.effectiveAt = result.effectiveAt
      }
      await this.storage.set({ state })

      for (const consumed of result.consumedFrom ?? []) {
        await this.storage.insertUsageRecord({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
          usage: consumed.amount,
          timestamp: params.timestamp,
          grantId: consumed.grantId,
          idempotenceKey: params.idempotenceKey,
          requestId: params.requestId,
          entitlementId: state.id,
          featurePlanVersionId: consumed.featurePlanVersionId,
          subscriptionItemId: consumed.subscriptionItemId,
          subscriptionPhaseId: consumed.subscriptionPhaseId,
          subscriptionId: consumed.subscriptionId,
          createdAt: Date.now(),
          metadata: params.metadata,
          deleted: 0,
        })
      }

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
        entitlementId: event.entitlementId,
        customerId: event.customerId,
        projectId: event.projectId,
        timestamp: event.timestamp,
        status: event.deniedReason,
        metadata: event.metadata,
        latency: event.latency ? Number(event.latency) : 0,
        requestId: event.requestId,
        allowed: event.allowed,
      }))

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
              customerId: transformedEvents[0]?.customerId,
              projectId: transformedEvents[0]?.projectId,
            })
          } else {
            this.logger.debug(
              "the total of verifications sent to tinybird are not the same as the total of verifications in the db",
              {
                total,
                expected: verifications.length,
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

    if (deduplicatedEvents.length > 0) {
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
        })
        throw error
      }
    } else {
      return Ok({
        success: true,
        quarantined: 0,
      })
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
    const states = await this.db.query.entitlements.findMany({
      where: (e, { and, eq }) => and(eq(e.customerId, customerId), eq(e.projectId, projectId)),
    })

    for (const state of states) {
      // Ensure revalidation fields are set
      if (!state.nextRevalidateAt) {
        state.nextRevalidateAt = now + this.revalidateInterval
      }

      await this.storage.set({ state })
      await this.cache.customerEntitlement.set(
        this.makeEntitlementKey({
          customerId: state.customerId,
          projectId: state.projectId,
          featureSlug: state.featureSlug,
        }),
        state
      )
    }
  }

  /**
   * Flush usage records to analytics
   */
  public async flushUsageRecords(): Promise<Result<void, UnPriceEntitlementStorageError>> {
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
  public async invalidateEntitlement(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<void> {
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

    // delete the entitlement from the storage
    await this.storage.delete(params)

    // delete the entitlement from the cache in background
    await this.cache.customerEntitlement.remove(this.makeEntitlementKey(params))
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

      // get the entitlement
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
      this.logger.debug("Current cycle ended, recomputing grants", params)

      const result = await this.grantsManager.computeGrantsForCustomer({
        customerId: params.customerId,
        projectId: params.projectId,
        now: params.now,
      })

      if (result.err) {
        this.logger.error("Failed to recompute grants after cycle reset", {
          error: result.err.message,
          ...params,
        })

        return null
      }

      // get entitlements from the result
      const entitlement = result.val.find((e) => e.featureSlug === params.featureSlug)

      if (!entitlement) {
        this.logger.error("Failed to find entitlement after cycle reset", {
          error: "Entitlement not found after cycle reset",
          ...params,
        })

        return null
      }

      // set storage
      await this.storage.set({ state: entitlement })

      return entitlement
    }

    // Cache hit - no cycle boundary crossed, check if we need to revalidate
    if (params.now >= cached.nextRevalidateAt) {
      this.logger.debug("Revalidation time, checking version", params)

      // Lightweight version check (just query version number)
      // TODO: here we need to check if getting the versions and the last one
      // maybe add a latest version? or maybe hashing grants as version?
      const dbVersion = await this.db.query.entitlements.findFirst({
        where: (e, { and, eq }) =>
          and(
            eq(e.customerId, params.customerId),
            eq(e.projectId, params.projectId),
            eq(e.featureSlug, params.featureSlug)
          ),
        columns: { version: true, computedAt: true },
      })

      // no version found, entitlement deleted
      if (!dbVersion) {
        // Entitlement deleted, invalidate cache
        await this.invalidateEntitlement({
          customerId: params.customerId,
          projectId: params.projectId,
          featureSlug: params.featureSlug,
        })

        return null
      }

      // Version mismatch or snapshot updated - reload
      // entitlement was recomputed with changes in grants
      if (dbVersion.version !== cached.version) {
        this.logger.info("Version mismatch detected, reloading", {
          ...params,
          cachedVersion: cached.version,
          dbVersion: dbVersion.version,
        })

        // reload the entitlement from cache
        const { val, err } = await this.getActiveEntitlement({
          ...params,
          opts: {
            skipCache: params.skipCache,
          },
        })

        if (err) {
          this.logger.error("Failed to reload entitlement from cache", {
            error: err.message,
            ...params,
          })

          return null
        }

        // set storage
        await this.storage.set({ state: val })

        return val
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
    if (Date.now() - state.lastSyncAt < this.syncToDBInterval) {
      return
    }

    const updated = await this.db
      .update(entitlements)
      .set({
        currentCycleUsage: state.currentCycleUsage.toString(),
        lastSyncAt: Date.now(),
      })
      .where(and(eq(entitlements.id, state.id), eq(entitlements.projectId, state.projectId)))
      .returning()
      .then((res) => res[0])

    if (!updated) {
      return
    }

    // Update cache
    await this.cache.customerEntitlement.set(
      this.makeEntitlementKey({
        customerId: state.customerId,
        projectId: state.projectId,
        featureSlug: state.featureSlug,
      }),
      updated
    )
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

  public async getEntitlements({
    customerId,
    projectId,
  }: {
    customerId: string
    projectId: string
  }): Promise<
    Result<EntitlementState[], UnPriceEntitlementError | UnPriceEntitlementStorageError>
  > {
    // the entitlement should be prewarmed in the service
    const { val: entitlements, err } = await this.storage.getAll()

    if (err) {
      throw err
    }

    // small validation to check if the entitlements are valid
    // and belongs to the customer and project
    const validEntitlements = entitlements.filter((entitlement) => {
      const isValid = entitlement.customerId === customerId && entitlement.projectId === projectId
      return isValid
    })

    return Ok(validEntitlements)
  }
}
