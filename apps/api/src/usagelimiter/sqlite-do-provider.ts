import type { Analytics, AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { EntitlementState } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { LakehouseCursorState, LakehouseService } from "@unprice/lakehouse"
import { LAKEHOUSE_SCHEMA_VERSION } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logging"
import {
  type UnPriceEntitlementStorage,
  UnPriceEntitlementStorageError,
} from "@unprice/services/entitlements"
import { desc, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import xxhash, { type XXHashAPI } from "xxhash-wasm"
import { type UsageRecord, type Verification, schema } from "~/db/types"
import {
  buildLakehouseMetadataProcessingResult,
  buildLakehousePreparedPayload,
} from "~/lakehouse/pipeline"
import migrations from "../../drizzle/migrations"

// Constants
const BATCH_SIZE = 1000
const METADATA_RETENTION_DAYS = 3
const WINDOW_5_MIN = 300
const WINDOW_60_MIN = 3600
const WINDOW_1_DAY = 86400
const WINDOW_7_DAYS = 604800
const MINUTE_BUCKET_SECONDS = 60
const FIVE_MIN_BUCKET_SECONDS = WINDOW_5_MIN
const HOUR_BUCKET_SECONDS = 3600
const DAY_BUCKET_SECONDS = WINDOW_1_DAY
const AGGREGATE_BUCKETS = [
  MINUTE_BUCKET_SECONDS,
  FIVE_MIN_BUCKET_SECONDS,
  HOUR_BUCKET_SECONDS,
  DAY_BUCKET_SECONDS,
] as const
const MINUTE_AGGREGATE_RETENTION_SECONDS = WINDOW_5_MIN
const FIVE_MIN_AGGREGATE_RETENTION_SECONDS = WINDOW_60_MIN
const HOUR_AGGREGATE_RETENTION_SECONDS = WINDOW_1_DAY
const DAY_AGGREGATE_RETENTION_SECONDS = WINDOW_7_DAYS
const STATE_KEY_PREFIX = "state:"
const SEEN_META_PREFIX = "seen_meta_"
const SEEN_SNAPSHOT_PREFIX = "seen_snapshot_"
const CURSOR_KEY = "cursor_state"

// Type guard for EntitlementState
function isEntitlementState(value: unknown): value is EntitlementState {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.customerId === "string" &&
    typeof obj.projectId === "string" &&
    typeof obj.featureSlug === "string"
  )
}

// Batch result type for type safety
interface BatchResult<T, ID> {
  records: T[]
  firstId: ID | null
  lastId: ID | null
}

// Tinybird ingestion payload types (what analytics.ingest* methods expect)
interface TinybirdUsagePayload {
  id: string
  timestamp: number
  usage: number
  deleted: number
  project_id: string
  customer_id: string
  feature_slug: string
  created_at: number
  idempotence_key: string
  // schema evolution tracking
  schema_version: number
}

interface TinybirdVerificationPayload {
  timestamp: number
  latency: number
  denied_reason: string | undefined
  allowed: number
  project_id: string
  customer_id: string
  feature_slug: string
  created_at: number
  region: string
  // schema evolution tracking
  schema_version: number
}

// Processed record with metadata for internal use
interface CursorState {
  lastTinybirdUsageId: string | null
  lastR2UsageId: string | null
  lastTinybirdVerificationId: number | null
  lastR2VerificationId: number | null
}

type LakehouseMetadataProcessingResult = Awaited<
  ReturnType<typeof buildLakehouseMetadataProcessingResult>
>
type LakehousePreparedPayload = ReturnType<typeof buildLakehousePreparedPayload>
type ProcessedUsageRecords = LakehouseMetadataProcessingResult["usageRecords"]
type ProcessedVerificationRecords = LakehouseMetadataProcessingResult["verificationRecords"]

export interface FlushPressureStats {
  pendingUsageRecords: number
  pendingVerificationRecords: number
  pendingTotalRecords: number
  oldestPendingTimestamp: number | null
  oldestPendingAgeSeconds: number
}

/**
 * SQLite Storage Provider for Durable Objects
 *
 * Key design principles:
 * 1. All state mutations happen inside blockConcurrencyWhile to prevent race conditions
 * 2. Fail-fast with Result type - no throwing except for unrecoverable errors
 * 3. Single responsibility methods with clear boundaries
 * 4. Type-safe transformations between storage and analytics types
 */
export class SqliteDOStorageProvider implements UnPriceEntitlementStorage {
  readonly name = "sqlite-do"

  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly storage: DurableObjectStorage
  private readonly state: DurableObjectState
  private readonly analytics: Analytics
  private readonly logger: Logger
  private readonly lakehouseService: LakehouseService

  // Memoized entitlement states for fast lookups
  private stateCache = new Map<string, EntitlementState>()
  private initialized = false
  private cursors: CursorState = {
    lastTinybirdUsageId: null,
    lastR2UsageId: null,
    lastTinybirdVerificationId: null,
    lastR2VerificationId: null,
  }

  // Lazily initialized xxhash instance (WASM module)
  private xxhashInstance: XXHashAPI | null = null

  constructor(args: {
    storage: DurableObjectStorage
    state: DurableObjectState
    analytics: Analytics
    logger: Logger
    lakehouseService: LakehouseService
  }) {
    this.storage = args.storage
    this.state = args.state
    this.analytics = args.analytics
    this.logger = args.logger
    this.lakehouseService = args.lakehouseService
    this.db = drizzle(args.storage, { schema, logger: false })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.db, migrations)
        await this.loadStateCache()
        await this.loadCursors()
        this.initialized = true
        return Ok(undefined)
      } catch (error) {
        this.initialized = false
        this.stateCache.clear()
        return this.logAndError("initialize", error)
      }
    })
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new UnPriceEntitlementStorageError({ message: "Storage provider not initialized" })
    }
  }

  private async loadStateCache(): Promise<void> {
    const entries = await this.storage.list({ prefix: STATE_KEY_PREFIX })
    this.stateCache.clear()

    for (const [key, value] of entries) {
      if (isEntitlementState(value)) {
        this.stateCache.set(key, value)
      }
    }
  }

  private async loadCursors(): Promise<void> {
    const stored = await this.storage.get<CursorState>(CURSOR_KEY)
    if (stored) {
      this.cursors = stored
    }
  }

  private async saveCursors(): Promise<void> {
    await this.storage.put(CURSOR_KEY, this.cursors)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State CRUD Operations
  // ─────────────────────────────────────────────────────────────────────────────

  async get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const key = this.makeKey(params)

      // Check cache first
      const cached = this.stateCache.get(key)
      if (cached) return Ok(cached)

      // Fall back to storage
      const value = await this.storage.get(key)
      if (value && isEntitlementState(value)) {
        this.stateCache.set(key, value)
        return Ok(value)
      }

      return Ok(null)
    } catch (error) {
      return this.logAndError("get", error)
    }
  }

  async getAll(): Promise<Result<EntitlementState[], UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      return Ok(Array.from(this.stateCache.values()))
    } catch (error) {
      return this.logAndError("getAll", error)
    }
  }

  async set(params: {
    state: EntitlementState
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const key = this.makeKey({
        customerId: params.state.customerId,
        projectId: params.state.projectId,
        featureSlug: params.state.featureSlug,
      })

      await this.storage.put(key, params.state)
      this.stateCache.set(key, params.state)

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("set", error)
    }
  }

  async delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const key = this.makeKey(params)

      await this.storage.delete(key)
      this.stateCache.delete(key)

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("delete", error)
    }
  }

  async deleteAll(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        this.assertInitialized()
        await this.storage.deleteAll()
        this.stateCache.clear()
        await migrate(this.db, migrations)
        return Ok(undefined)
      } catch (error) {
        return this.logAndError("deleteAll", error)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Usage & Verification Recording
  // ─────────────────────────────────────────────────────────────────────────────

  async hasIdempotenceKey(
    idempotenceKey: string
  ): Promise<Result<boolean, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      const result = await this.db
        .select({ id: schema.usageRecords.id })
        .from(schema.usageRecords)
        .where(sql`${schema.usageRecords.idempotence_key} = ${idempotenceKey}`)
        .limit(1)

      return Ok(result.length > 0)
    } catch (error) {
      return this.logAndError("hasIdempotenceKey", error)
    }
  }

  async insertUsageRecord(
    record: AnalyticsUsage
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      const inserted = await this.db
        .insert(schema.usageRecords)
        .values({
          id: record.id,
          customer_id: record.customer_id,
          feature_slug: record.feature_slug,
          usage: String(record.usage),
          timestamp: record.timestamp,
          created_at: record.created_at,
          metadata: record.metadata ? JSON.stringify(record.metadata) : null,
          cost: record.cost != null ? String(record.cost) : null,
          rate_amount: record.rate_amount != null ? String(record.rate_amount) : null,
          rate_currency: record.rate_currency ?? null,
          entitlement_snapshot_id: record.entitlement_snapshot_id ?? null,
          entitlement_version: record.entitlement_version ?? null,
          entitlement_feature_type: record.entitlement_feature_type ?? null,
          entitlement_limit: record.entitlement_limit ?? null,
          entitlement_overage_strategy: record.entitlement_overage_strategy ?? null,
          entitlement_effective_at: record.entitlement_effective_at ?? null,
          entitlement_expires_at: record.entitlement_expires_at ?? null,
          entitlement_snapshot: record.entitlement_snapshot ?? null,
          deleted: record.deleted ?? 0,
          idempotence_key: record.idempotence_key,
          request_id: record.request_id,
          project_id: record.project_id,
          // first-class analytics columns
          country: record.country ?? "UNK",
          region: record.region ?? "UNK",
          action: record.action ?? null,
          key_id: record.key_id ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.usageRecords.id })

      if (inserted.length === 0) {
        return Ok(undefined)
      }

      await this.updateUsageAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        usage: Number(record.usage ?? 0),
      })

      await this.updateReportUsageAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        reportUsage: 1,
        limitExceeded: 0,
      })

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("insertUsageRecord", error)
    }
  }

  async insertVerification(
    record: AnalyticsVerification
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      await this.db.insert(schema.verifications).values({
        customer_id: record.customer_id,
        feature_slug: record.feature_slug,
        project_id: record.project_id,
        timestamp: record.timestamp,
        created_at: record.created_at,
        request_id: record.request_id,
        denied_reason: record.denied_reason ?? null,
        latency: record.latency != null ? String(record.latency) : "0",
        allowed: record.allowed,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
        usage: record.usage != null ? String(record.usage) : null,
        remaining: record.remaining != null ? String(record.remaining) : null,
        entitlement_snapshot_id: record.entitlement_snapshot_id ?? null,
        entitlement_version: record.entitlement_version ?? null,
        entitlement_feature_type: record.entitlement_feature_type ?? null,
        entitlement_limit: record.entitlement_limit ?? null,
        entitlement_overage_strategy: record.entitlement_overage_strategy ?? null,
        entitlement_effective_at: record.entitlement_effective_at ?? null,
        entitlement_expires_at: record.entitlement_expires_at ?? null,
        entitlement_snapshot: record.entitlement_snapshot ?? null,
        // first-class analytics columns
        country: record.country ?? "UNK",
        region: record.region ?? "UNK",
        action: record.action ?? null,
        key_id: record.key_id ?? null,
      })

      await this.updateVerificationAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        allowed: record.allowed,
      })

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("insertVerification", error)
    }
  }

  async insertReportUsageDeniedEvent(record: {
    project_id: string
    customer_id: string
    feature_slug: string
    timestamp: number
    denied_reason: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      if (record.denied_reason !== "LIMIT_EXCEEDED") {
        return Ok(undefined)
      }

      await this.updateReportUsageAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        reportUsage: 1,
        limitExceeded: 1,
      })

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("insertReportUsageDeniedEvent", error)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Flush & Reset
  // ─────────────────────────────────────────────────────────────────────────────

  async flush(): Promise<
    Result<
      {
        usage: { count: number; lastId: string | null }
        verification: { count: number; lastId: string | null }
      },
      UnPriceEntitlementStorageError
    >
  > {
    try {
      this.assertInitialized()

      // 1. Fetch batches
      const usageBatch = await this.fetchUsageBatch()
      const verificationBatch = await this.fetchVerificationBatch()

      // 2. Process metadata/tag payloads for lakehouse sinks
      const todayKey = this.getTodayKey()
      const seenMetaSet = await this.getSeenMetaSet(todayKey)
      const processed = await buildLakehouseMetadataProcessingResult({
        usageRecords: usageBatch.records,
        verificationRecords: verificationBatch.records,
        seenMetaSet,
        todayKey,
        hashMetadataJson: async (metadataJson) => {
          const hasher = await this.getXxhash()
          return hasher.h64(metadataJson)
        },
      })

      const lakehouseSnapshotDate = new Date().toISOString().slice(0, 10)
      const seenSnapshotSet = await this.getSeenSnapshotSet(lakehouseSnapshotDate)
      const lakehousePrepared = buildLakehousePreparedPayload({
        processed,
        cursorState: {
          lastR2UsageId: this.cursors.lastR2UsageId,
          lastR2VerificationId: this.cursors.lastR2VerificationId,
        },
        seenSnapshotSet,
        seenSnapshotDate: lakehouseSnapshotDate,
      })

      // 3. Filter records for each destination based on cursors to avoid double counting
      const usageForTinybird = processed.usageRecords.filter((r) => {
        if (!this.cursors.lastTinybirdUsageId) return true
        return r.record.id > this.cursors.lastTinybirdUsageId
      })

      const verificationForTinybird = processed.verificationRecords.filter((r) => {
        if (this.cursors.lastTinybirdVerificationId === null) return true
        return r.record.id > this.cursors.lastTinybirdVerificationId
      })

      // 4. Send to destinations in parallel
      const [r2Result, usageResult, verificationResult] = await Promise.all([
        this.flushToR2(lakehousePrepared),
        this.ingestUsageToTinybird(usageForTinybird),
        this.ingestVerificationsToTinybird(verificationForTinybird),
      ])

      const allFlushesSucceeded =
        r2Result.success && usageResult.success && verificationResult.success

      if (allFlushesSucceeded) {
        // 5a. Update tinybird cursors first (same filter as the payload that was sent)
        if (
          usageForTinybird.length > 0 &&
          this.cursors.lastTinybirdUsageId !== usageForTinybird[0]!.record.id
        ) {
          this.cursors.lastTinybirdUsageId = usageForTinybird[0]!.record.id
        }

        if (
          verificationForTinybird.length > 0 &&
          this.cursors.lastTinybirdVerificationId !==
            verificationForTinybird[verificationForTinybird.length - 1]!.record.id
        ) {
          this.cursors.lastTinybirdVerificationId =
            verificationForTinybird[verificationForTinybird.length - 1]!.record.id
        }

        // 5b. Persist sinks that use the same payload and commit once both destinations succeed
        this.cursors.lastR2UsageId = r2Result.cursorState.lastR2UsageId
        this.cursors.lastR2VerificationId = r2Result.cursorState.lastR2VerificationId

        await this.saveCursors()

        // 6. Update seen metadata/snapshot sets only after a fully successful flush
        if (processed.uniqueMetadata.length > 0) {
          await this.updateSeenMetaSet(processed.todayKey, processed.seenMetaSet)
        }

        if (lakehousePrepared.seenSnapshotSet.size > 0) {
          await this.updateSeenSnapshotSet(
            lakehousePrepared.seenSnapshotDate,
            lakehousePrepared.seenSnapshotSet
          )
        }

        // 7. Delete records that have been safely persisted to BOTH destinations
        // For Usage (DESC): We can delete if both cursors have advanced past the batch
        if (usageBatch.firstId && usageBatch.lastId) {
          const tbSafe =
            this.cursors.lastTinybirdUsageId !== null &&
            usageBatch.firstId !== null &&
            this.cursors.lastTinybirdUsageId >= usageBatch.firstId
          const r2Safe =
            this.cursors.lastR2UsageId !== null &&
            usageBatch.firstId !== null &&
            this.cursors.lastR2UsageId >= usageBatch.firstId

          if (tbSafe && r2Safe) {
            await this.deleteUsageRecordsBatch(usageBatch.firstId, usageBatch.lastId)
          }
        }

        // For Verification (ASC): We can delete if both cursors have advanced past the batch
        if (verificationBatch.firstId !== null && verificationBatch.lastId !== null) {
          const tbSafe =
            this.cursors.lastTinybirdVerificationId !== null &&
            verificationBatch.lastId !== null &&
            this.cursors.lastTinybirdVerificationId >= verificationBatch.lastId
          const r2Safe =
            this.cursors.lastR2VerificationId !== null &&
            verificationBatch.lastId !== null &&
            this.cursors.lastR2VerificationId >= verificationBatch.lastId

          if (tbSafe && r2Safe) {
            await this.deleteVerificationRecordsBatch(
              verificationBatch.firstId,
              verificationBatch.lastId
            )
          }
        }
      }

      await this.pruneAggregateBuckets(Date.now())

      return Ok({
        usage: { count: usageBatch.records.length, lastId: usageBatch.lastId },
        verification: {
          count: verificationBatch.records.length,
          lastId: verificationBatch.lastId?.toString() ?? null,
        },
      })
    } catch (error) {
      return this.logAndError("flush", error)
    }
  }

  async reset(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    // Wrap entire reset in blockConcurrencyWhile to prevent race conditions
    return this.state.blockConcurrencyWhile(async () => {
      try {
        // 1. Try to flush pending data
        const flushResult = await this.flush()
        if (flushResult.err) {
          this.logger.warn("Flush during reset failed, continuing anyway", {
            error: flushResult.err.message,
          })
        }

        // 2. Check for remaining records
        const [usageCount, verificationCount] = await Promise.all([
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(schema.usageRecords)
            .then((r) => r[0]?.count ?? 0),
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(schema.verifications)
            .then((r) => r[0]?.count ?? 0),
        ])

        if (usageCount > 0 || verificationCount > 0) {
          return Err(
            new UnPriceEntitlementStorageError({
              message: `Cannot reset: ${usageCount} usage records and ${verificationCount} verifications pending`,
            })
          )
        }

        // 3. Clear everything and reinitialize
        this.stateCache.clear()
        await this.storage.deleteAll()
        this.initialized = false
        this.cursors = {
          lastTinybirdUsageId: null,
          lastR2UsageId: null,
          lastTinybirdVerificationId: null,
          lastR2VerificationId: null,
        }

        // Reinitialize
        await migrate(this.db, migrations)
        await this.loadStateCache()
        // No need to load cursors as we just reset them
        this.initialized = true

        return Ok(undefined)
      } catch (error) {
        return this.logAndError("reset", error)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Batch Fetching
  // ─────────────────────────────────────────────────────────────────────────────

  private async fetchUsageBatch(): Promise<BatchResult<UsageRecord, string>> {
    const records = await this.db
      .select()
      .from(schema.usageRecords)
      .orderBy(desc(schema.usageRecords.id))
      .limit(BATCH_SIZE)

    if (records.length === 0) {
      return { records: [], firstId: null, lastId: null }
    }

    // Deduplicate by idempotence_key (keep first occurrence)
    const seen = new Set<string>()
    const deduplicated = records.filter((r) => {
      if (seen.has(r.idempotence_key)) return false
      seen.add(r.idempotence_key)
      return true
    })

    // firstId is highest (DESC order), lastId is lowest
    const firstId = records[0]?.id ?? null
    const lastId = records[records.length - 1]?.id ?? null

    return { records: deduplicated, firstId, lastId }
  }

  private async fetchVerificationBatch(): Promise<BatchResult<Verification, number>> {
    const records = await this.db
      .select()
      .from(schema.verifications)
      .orderBy(schema.verifications.id)
      .limit(BATCH_SIZE)

    if (records.length === 0) {
      return { records: [], firstId: null, lastId: null }
    }

    const firstId = records[0]?.id ?? null
    const lastId = records[records.length - 1]?.id ?? null

    return { records, firstId, lastId }
  }

  private async getXxhash(): Promise<XXHashAPI> {
    if (!this.xxhashInstance) {
      this.xxhashInstance = await xxhash()
    }
    return this.xxhashInstance
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tinybird Ingestion
  // ─────────────────────────────────────────────────────────────────────────────

  private async ingestUsageToTinybird(
    records: ProcessedUsageRecords
  ): Promise<{ success: boolean }> {
    if (records.length === 0) return { success: true }

    try {
      const payload: TinybirdUsagePayload[] = records.map(({ record }) => ({
        id: record.id,
        timestamp: record.timestamp,
        usage: Number(record.usage ?? 0),
        deleted: record.deleted,
        project_id: record.project_id,
        customer_id: record.customer_id,
        feature_slug: record.feature_slug,
        created_at: record.created_at,
        idempotence_key: record.idempotence_key,
        schema_version: LAKEHOUSE_SCHEMA_VERSION,
      }))

      const result = await this.analytics.ingestFeaturesUsage(payload)

      // Verify all rows were processed (either successful or quarantined)
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0
      const total = successful + quarantined

      if (quarantined > 0) {
        this.logger.warn("Tinybird usage rows quarantined", {
          expected: records.length,
          successful,
          quarantined,
        })
      }

      if (total >= records.length) {
        return { success: true }
      }

      this.logger.warn("Tinybird usage ingestion incomplete", {
        expected: records.length,
        successful,
        quarantined,
      })
      return { success: false }
    } catch (error) {
      this.logger.error("Failed to ingest usage to Tinybird", { error: this.errorMessage(error) })
      return { success: false }
    }
  }

  private async ingestVerificationsToTinybird(
    records: ProcessedVerificationRecords
  ): Promise<{ success: boolean }> {
    if (records.length === 0) return { success: true }

    try {
      const payload: TinybirdVerificationPayload[] = records.map(({ record, region }) => ({
        timestamp: record.timestamp,
        latency: record.latency ? Number(record.latency) : 0,
        denied_reason: record.denied_reason ?? undefined,
        allowed: record.allowed,
        project_id: record.project_id,
        customer_id: record.customer_id,
        feature_slug: record.feature_slug,
        created_at: record.created_at,
        region,
        schema_version: LAKEHOUSE_SCHEMA_VERSION,
      }))

      const result = await this.analytics.ingestFeaturesVerification(payload)

      // Verify all rows were processed
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0
      const total = successful + quarantined

      if (quarantined > 0) {
        this.logger.warn("Tinybird verification rows quarantined", {
          expected: records.length,
          successful,
          quarantined,
        })
      }

      if (total >= records.length) {
        return { success: true }
      }

      this.logger.warn("Tinybird verification ingestion incomplete", {
        expected: records.length,
        successful,
        quarantined,
      })
      return { success: false }
    } catch (error) {
      this.logger.error("Failed to ingest verifications to Tinybird", {
        error: this.errorMessage(error),
      })
      return { success: false }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Record Deletion
  // ─────────────────────────────────────────────────────────────────────────────

  private async deleteUsageRecordsBatch(firstId: string, lastId: string): Promise<number> {
    // Usage is ordered DESC, so firstId > lastId lexicographically
    const result = await this.db
      .delete(schema.usageRecords)
      .where(
        sql`${schema.usageRecords.id} >= ${lastId} AND ${schema.usageRecords.id} <= ${firstId}`
      )
      .returning({ id: schema.usageRecords.id })

    return result.length
  }

  private async deleteVerificationRecordsBatch(firstId: number, lastId: number): Promise<number> {
    // Verifications ordered ASC, so firstId < lastId
    const result = await this.db
      .delete(schema.verifications)
      .where(
        sql`${schema.verifications.id} >= ${firstId} AND ${schema.verifications.id} <= ${lastId}`
      )
      .returning({ id: schema.verifications.id })

    return result.length
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // R2 Lakehouse
  // ─────────────────────────────────────────────────────────────────────────────

  private async flushToR2(
    prepared: LakehousePreparedPayload
  ): Promise<{ success: boolean; cursorState: LakehouseCursorState }> {
    try {
      if (
        prepared.usageRecords.length === 0 &&
        prepared.verificationRecords.length === 0 &&
        prepared.metadataRecords.length === 0 &&
        prepared.entitlementSnapshots.length === 0
      ) {
        return { success: true, cursorState: prepared.cursorState }
      }

      const lakehouseResult = await this.lakehouseService.flushRaw({
        cursorState: prepared.cursorState,
        usageRecords: prepared.usageRecords,
        verificationRecords: prepared.verificationRecords,
        metadataRecords: prepared.metadataRecords,
        entitlementSnapshots: prepared.entitlementSnapshots,
      })

      return {
        success: lakehouseResult.success,
        cursorState: lakehouseResult.cursorState,
      }
    } catch (error) {
      this.logger.error("Failed to flush to R2", { error: this.errorMessage(error) })
      return { success: false, cursorState: prepared.cursorState }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Seen Metadata Management
  // ─────────────────────────────────────────────────────────────────────────────

  private getTodayKey(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private async getSeenMetaSet(date: string): Promise<Set<string>> {
    const key = `${SEEN_META_PREFIX}${date}`
    const stored = await this.storage.get<string[]>(key)
    return new Set(stored ?? [])
  }

  private async getSeenSnapshotSet(date: string): Promise<Set<string>> {
    const key = `${SEEN_SNAPSHOT_PREFIX}${date}`
    const stored = await this.storage.get<string[]>(key)
    return new Set(stored ?? [])
  }

  private async updateSeenMetaSet(date: string, metaIds: Set<string>): Promise<void> {
    const key = `${SEEN_META_PREFIX}${date}`
    await this.storage.put(key, Array.from(metaIds))
    await this.rotateSeenMetadata(date)
  }

  private async updateSeenSnapshotSet(date: string, snapshotIds: Set<string>): Promise<void> {
    const key = `${SEEN_SNAPSHOT_PREFIX}${date}`
    await this.storage.put(key, Array.from(snapshotIds))
    await this.rotateSeenSnapshots(date)
  }

  private async rotateSeenMetadata(currentDateStr: string): Promise<void> {
    try {
      const keys = await this.storage.list({ prefix: SEEN_META_PREFIX })
      const cutoffDate = new Date(currentDateStr)
      cutoffDate.setDate(cutoffDate.getDate() - METADATA_RETENTION_DAYS)

      const keysToDelete: string[] = []

      for (const [key] of keys) {
        const datePart = key.replace(SEEN_META_PREFIX, "")
        const keyDate = new Date(datePart)

        if (!Number.isNaN(keyDate.getTime()) && keyDate < cutoffDate) {
          keysToDelete.push(key)
        }
      }

      if (keysToDelete.length > 0) {
        await Promise.all(keysToDelete.map((key) => this.storage.delete(key)))
      }
    } catch (error) {
      this.logger.error("Failed to rotate seen metadata", { error: this.errorMessage(error) })
    }
  }

  private async rotateSeenSnapshots(currentDateStr: string): Promise<void> {
    try {
      const keys = await this.storage.list({ prefix: SEEN_SNAPSHOT_PREFIX })
      const cutoffDate = new Date(currentDateStr)
      cutoffDate.setDate(cutoffDate.getDate() - METADATA_RETENTION_DAYS)

      const keysToDelete: string[] = []

      for (const [key] of keys) {
        const datePart = key.replace(SEEN_SNAPSHOT_PREFIX, "")
        const keyDate = new Date(datePart)

        if (!Number.isNaN(keyDate.getTime()) && keyDate < cutoffDate) {
          keysToDelete.push(key)
        }
      }

      if (keysToDelete.length > 0) {
        await Promise.all(keysToDelete.map((key) => this.storage.delete(key)))
      }
    } catch (error) {
      this.logger.error("Failed to rotate seen snapshots", { error: this.errorMessage(error) })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Buffer Stats (Real-time Metrics)
  // ─────────────────────────────────────────────────────────────────────────────

  async getFlushPressure(): Promise<Result<FlushPressureStats, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      const [usageStats, verificationStats] = await Promise.all([
        this.db
          .select({
            count: sql<number>`count(*)`,
            oldestTimestamp: sql<number | null>`min(${schema.usageRecords.timestamp})`,
          })
          .from(schema.usageRecords),
        this.db
          .select({
            count: sql<number>`count(*)`,
            oldestTimestamp: sql<number | null>`min(${schema.verifications.timestamp})`,
          })
          .from(schema.verifications),
      ])

      const pendingUsageRecords = usageStats[0]?.count ?? 0
      const pendingVerificationRecords = verificationStats[0]?.count ?? 0
      const pendingTotalRecords = pendingUsageRecords + pendingVerificationRecords

      const usageOldest = usageStats[0]?.oldestTimestamp ?? null
      const verificationOldest = verificationStats[0]?.oldestTimestamp ?? null

      const oldestPendingTimestamp =
        usageOldest === null
          ? verificationOldest
          : verificationOldest === null
            ? usageOldest
            : Math.min(usageOldest, verificationOldest)

      const oldestPendingAgeSeconds = oldestPendingTimestamp
        ? Math.max(0, Math.floor((Date.now() - oldestPendingTimestamp) / 1000))
        : 0

      return Ok({
        pendingUsageRecords,
        pendingVerificationRecords,
        pendingTotalRecords,
        oldestPendingTimestamp,
        oldestPendingAgeSeconds,
      })
    } catch (error) {
      return this.logAndError("getFlushPressure", error)
    }
  }

  /**
   * Returns aggregated statistics for unflushed records in the DO SQLite buffer.
   * This is used for real-time metrics without querying Tinybird.
   *
   * Returns counts and aggregations of pending usage/verification records that
   * haven't been flushed to Tinybird/R2 yet (typically seconds to minutes old).
   */
  async getBufferStats(windowSeconds = WINDOW_60_MIN): Promise<
    Result<
      {
        usageCount: number
        verificationCount: number
        totalUsage: number
        allowedCount: number
        deniedCount: number
        limitExceededCount: number
        bucketSizeSeconds: number
        featureStats: Array<{
          featureSlug: string
          usageCount: number
          verificationCount: number
          totalUsage: number
        }>
        usageSeries: Array<{
          bucketStart: number
          usageCount: number
          totalUsage: number
        }>
        verificationSeries: Array<{
          bucketStart: number
          verificationCount: number
          allowedCount: number
          deniedCount: number
          limitExceededCount: number
        }>
        oldestTimestamp: number | null
        newestTimestamp: number | null
      },
      UnPriceEntitlementStorageError
    >
  > {
    try {
      this.assertInitialized()

      const normalizedWindowSeconds =
        windowSeconds === WINDOW_5_MIN ||
        windowSeconds === WINDOW_60_MIN ||
        windowSeconds === WINDOW_1_DAY ||
        windowSeconds === WINDOW_7_DAYS
          ? windowSeconds
          : WINDOW_60_MIN

      const selectedBucketSizeSeconds =
        normalizedWindowSeconds <= WINDOW_5_MIN
          ? MINUTE_BUCKET_SECONDS
          : normalizedWindowSeconds <= WINDOW_60_MIN
            ? FIVE_MIN_BUCKET_SECONDS
            : normalizedWindowSeconds <= WINDOW_1_DAY
              ? HOUR_BUCKET_SECONDS
              : DAY_BUCKET_SECONDS
      const windowStart = Date.now() - normalizedWindowSeconds * 1000

      const usageSeries = await this.db
        .select({
          bucketStart: schema.usageAggregates.bucket_start,
          usageCount: sql<number>`sum(${schema.usageAggregates.usage_count})`,
          totalUsage: sql<number>`coalesce(sum(cast(${schema.usageAggregates.total_usage} as real)), 0)`,
        })
        .from(schema.usageAggregates)
        .where(
          sql`${schema.usageAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.usageAggregates.bucket_start} >= ${windowStart}`
        )
        .groupBy(schema.usageAggregates.bucket_start)
        .orderBy(schema.usageAggregates.bucket_start)

      const verificationSeries = await this.db
        .select({
          bucketStart: schema.verificationAggregates.bucket_start,
          verificationCount: sql<number>`sum(${schema.verificationAggregates.verification_count})`,
          allowedCount: sql<number>`sum(${schema.verificationAggregates.allowed_count})`,
          deniedCount: sql<number>`sum(${schema.verificationAggregates.denied_count})`,
        })
        .from(schema.verificationAggregates)
        .where(
          sql`${schema.verificationAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.verificationAggregates.bucket_start} >= ${windowStart}`
        )
        .groupBy(schema.verificationAggregates.bucket_start)
        .orderBy(schema.verificationAggregates.bucket_start)

      const reportUsageSeries = await this.db
        .select({
          bucketStart: schema.reportUsageAggregates.bucket_start,
          limitExceededCount: sql<number>`sum(${schema.reportUsageAggregates.limit_exceeded_count})`,
        })
        .from(schema.reportUsageAggregates)
        .where(
          sql`${schema.reportUsageAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.reportUsageAggregates.bucket_start} >= ${windowStart}`
        )
        .groupBy(schema.reportUsageAggregates.bucket_start)
        .orderBy(schema.reportUsageAggregates.bucket_start)

      const usageStatsByFeature = await this.db
        .select({
          featureSlug: schema.usageAggregates.feature_slug,
          usageCount: sql<number>`sum(${schema.usageAggregates.usage_count})`,
          totalUsage: sql<number>`coalesce(sum(cast(${schema.usageAggregates.total_usage} as real)), 0)`,
        })
        .from(schema.usageAggregates)
        .where(
          sql`${schema.usageAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.usageAggregates.bucket_start} >= ${windowStart}`
        )
        .groupBy(schema.usageAggregates.feature_slug)

      const verificationStatsByFeature = await this.db
        .select({
          featureSlug: schema.verificationAggregates.feature_slug,
          verificationCount: sql<number>`sum(${schema.verificationAggregates.verification_count})`,
          allowedCount: sql<number>`sum(${schema.verificationAggregates.allowed_count})`,
          deniedCount: sql<number>`sum(${schema.verificationAggregates.denied_count})`,
        })
        .from(schema.verificationAggregates)
        .where(
          sql`${schema.verificationAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.verificationAggregates.bucket_start} >= ${windowStart}`
        )
        .groupBy(schema.verificationAggregates.feature_slug)

      // Combine stats by feature
      const featureMap = new Map<
        string,
        {
          featureSlug: string
          usageCount: number
          verificationCount: number
          totalUsage: number
        }
      >()

      let totalUsageCount = 0
      let totalUsageSum = 0
      let totalVerificationCount = 0
      let totalAllowed = 0
      let totalDenied = 0
      let totalLimitExceeded = 0
      let oldestTimestamp: number | null = null
      let newestTimestamp: number | null = null

      for (const stat of usageStatsByFeature) {
        totalUsageCount += stat.usageCount
        totalUsageSum += stat.totalUsage

        featureMap.set(stat.featureSlug, {
          featureSlug: stat.featureSlug,
          usageCount: stat.usageCount,
          verificationCount: 0,
          totalUsage: stat.totalUsage,
        })
      }

      for (const stat of verificationStatsByFeature) {
        totalVerificationCount += stat.verificationCount
        totalAllowed += stat.allowedCount ?? 0
        totalDenied += stat.deniedCount ?? 0

        const existing = featureMap.get(stat.featureSlug)
        if (existing) {
          existing.verificationCount = stat.verificationCount
        } else {
          featureMap.set(stat.featureSlug, {
            featureSlug: stat.featureSlug,
            usageCount: 0,
            verificationCount: stat.verificationCount,
            totalUsage: 0,
          })
        }
      }

      const reportUsageByBucket = new Map(
        reportUsageSeries.map((bucket) => [
          bucket.bucketStart,
          {
            limitExceededCount: bucket.limitExceededCount,
          },
        ])
      )

      for (const bucket of reportUsageSeries) {
        totalLimitExceeded += bucket.limitExceededCount
      }

      const verificationSeriesMap = new Map(
        verificationSeries.map((bucket) => [
          bucket.bucketStart,
          {
            ...bucket,
            limitExceededCount: 0,
          },
        ])
      )

      for (const [bucketStart, reportUsage] of reportUsageByBucket) {
        const existing = verificationSeriesMap.get(bucketStart)
        if (existing) {
          existing.limitExceededCount = reportUsage.limitExceededCount
        } else {
          verificationSeriesMap.set(bucketStart, {
            bucketStart,
            verificationCount: 0,
            allowedCount: 0,
            deniedCount: 0,
            limitExceededCount: reportUsage.limitExceededCount,
          })
        }
      }

      const verificationSeriesRows = Array.from(verificationSeriesMap.values()).sort(
        (a, b) => a.bucketStart - b.bucketStart
      )

      const usageOldest = usageSeries[0]?.bucketStart ?? null
      const verificationOldest = verificationSeries[0]?.bucketStart ?? null
      const usageNewest = usageSeries[usageSeries.length - 1]?.bucketStart ?? null
      const verificationNewest =
        verificationSeries[verificationSeries.length - 1]?.bucketStart ?? null

      oldestTimestamp =
        usageOldest === null
          ? verificationOldest
          : verificationOldest === null
            ? usageOldest
            : Math.min(usageOldest, verificationOldest)

      newestTimestamp =
        usageNewest === null
          ? verificationNewest
          : verificationNewest === null
            ? usageNewest
            : Math.max(usageNewest, verificationNewest)

      return Ok({
        usageCount: totalUsageCount,
        verificationCount: totalVerificationCount,
        totalUsage: totalUsageSum,
        allowedCount: totalAllowed,
        deniedCount: totalDenied,
        limitExceededCount: totalLimitExceeded,
        bucketSizeSeconds: selectedBucketSizeSeconds,
        featureStats: Array.from(featureMap.values()),
        usageSeries,
        verificationSeries: verificationSeriesRows,
        oldestTimestamp,
        newestTimestamp,
      })
    } catch (error) {
      return this.logAndError("getBufferStats", error)
    }
  }

  private async updateUsageAggregates(data: {
    timestamp: number
    featureSlug: string
    usage: number
  }): Promise<void> {
    const now = Date.now()

    for (const bucketSizeSeconds of AGGREGATE_BUCKETS) {
      const bucketStart = this.getBucketStart(data.timestamp, bucketSizeSeconds)

      await this.db
        .insert(schema.usageAggregates)
        .values({
          bucket_start: bucketStart,
          bucket_size_seconds: bucketSizeSeconds,
          feature_slug: data.featureSlug,
          usage_count: 1,
          total_usage: String(data.usage),
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.usageAggregates.bucket_start,
            schema.usageAggregates.bucket_size_seconds,
            schema.usageAggregates.feature_slug,
          ],
          set: {
            usage_count: sql`${schema.usageAggregates.usage_count} + 1`,
            total_usage: sql`cast(${schema.usageAggregates.total_usage} as real) + ${data.usage}`,
            updated_at: now,
          },
        })
    }
  }

  private async updateReportUsageAggregates(data: {
    timestamp: number
    featureSlug: string
    reportUsage: number
    limitExceeded: number
  }): Promise<void> {
    const now = Date.now()

    for (const bucketSizeSeconds of AGGREGATE_BUCKETS) {
      const bucketStart = this.getBucketStart(data.timestamp, bucketSizeSeconds)

      await this.db
        .insert(schema.reportUsageAggregates)
        .values({
          bucket_start: bucketStart,
          bucket_size_seconds: bucketSizeSeconds,
          feature_slug: data.featureSlug,
          report_usage_count: data.reportUsage,
          limit_exceeded_count: data.limitExceeded,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.reportUsageAggregates.bucket_start,
            schema.reportUsageAggregates.bucket_size_seconds,
            schema.reportUsageAggregates.feature_slug,
          ],
          set: {
            report_usage_count: sql`${schema.reportUsageAggregates.report_usage_count} + ${data.reportUsage}`,
            limit_exceeded_count: sql`${schema.reportUsageAggregates.limit_exceeded_count} + ${data.limitExceeded}`,
            updated_at: now,
          },
        })
    }
  }

  private async updateVerificationAggregates(data: {
    timestamp: number
    featureSlug: string
    allowed: number
  }): Promise<void> {
    const now = Date.now()
    const allowedDelta = data.allowed === 1 ? 1 : 0
    const deniedDelta = data.allowed === 1 ? 0 : 1

    for (const bucketSizeSeconds of AGGREGATE_BUCKETS) {
      const bucketStart = this.getBucketStart(data.timestamp, bucketSizeSeconds)

      await this.db
        .insert(schema.verificationAggregates)
        .values({
          bucket_start: bucketStart,
          bucket_size_seconds: bucketSizeSeconds,
          feature_slug: data.featureSlug,
          verification_count: 1,
          allowed_count: allowedDelta,
          denied_count: deniedDelta,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.verificationAggregates.bucket_start,
            schema.verificationAggregates.bucket_size_seconds,
            schema.verificationAggregates.feature_slug,
          ],
          set: {
            verification_count: sql`${schema.verificationAggregates.verification_count} + 1`,
            allowed_count: sql`${schema.verificationAggregates.allowed_count} + ${allowedDelta}`,
            denied_count: sql`${schema.verificationAggregates.denied_count} + ${deniedDelta}`,
            updated_at: now,
          },
        })
    }
  }

  private getBucketStart(timestamp: number, bucketSizeSeconds: number): number {
    const bucketSizeMs = bucketSizeSeconds * 1000
    return Math.floor(timestamp / bucketSizeMs) * bucketSizeMs
  }

  private async pruneAggregateBuckets(nowMs: number): Promise<void> {
    const minuteCutoff = nowMs - MINUTE_AGGREGATE_RETENTION_SECONDS * 1000
    const fiveMinuteCutoff = nowMs - FIVE_MIN_AGGREGATE_RETENTION_SECONDS * 1000
    const hourCutoff = nowMs - HOUR_AGGREGATE_RETENTION_SECONDS * 1000
    const dayCutoff = nowMs - DAY_AGGREGATE_RETENTION_SECONDS * 1000

    await Promise.all([
      this.db
        .delete(schema.usageAggregates)
        .where(
          sql`(${schema.usageAggregates.bucket_size_seconds} = ${MINUTE_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${minuteCutoff}) OR (${schema.usageAggregates.bucket_size_seconds} = ${FIVE_MIN_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${fiveMinuteCutoff}) OR (${schema.usageAggregates.bucket_size_seconds} = ${HOUR_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${hourCutoff}) OR (${schema.usageAggregates.bucket_size_seconds} = ${DAY_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${dayCutoff})`
        ),
      this.db
        .delete(schema.verificationAggregates)
        .where(
          sql`(${schema.verificationAggregates.bucket_size_seconds} = ${MINUTE_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${minuteCutoff}) OR (${schema.verificationAggregates.bucket_size_seconds} = ${FIVE_MIN_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${fiveMinuteCutoff}) OR (${schema.verificationAggregates.bucket_size_seconds} = ${HOUR_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${hourCutoff}) OR (${schema.verificationAggregates.bucket_size_seconds} = ${DAY_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${dayCutoff})`
        ),
      this.db
        .delete(schema.reportUsageAggregates)
        .where(
          sql`(${schema.reportUsageAggregates.bucket_size_seconds} = ${MINUTE_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${minuteCutoff}) OR (${schema.reportUsageAggregates.bucket_size_seconds} = ${FIVE_MIN_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${fiveMinuteCutoff}) OR (${schema.reportUsageAggregates.bucket_size_seconds} = ${HOUR_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${hourCutoff}) OR (${schema.reportUsageAggregates.bucket_size_seconds} = ${DAY_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${dayCutoff})`
        ),
    ])
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Helper to generate keys
   */
  public makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `${STATE_KEY_PREFIX}${params.projectId}:${params.customerId}:${params.featureSlug}`
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown"
  }

  private logAndError<T>(
    operation: string,
    error: unknown
  ): Result<T, UnPriceEntitlementStorageError> {
    const message = this.errorMessage(error)
    this.logger.error(`Storage provider ${this.state.id.toString()} ${operation} failed`, {
      error: message,
    })
    return Err(new UnPriceEntitlementStorageError({ message: `${operation} failed: ${message}` }))
  }
}
