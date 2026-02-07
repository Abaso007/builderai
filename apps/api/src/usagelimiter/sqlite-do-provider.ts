import type { R2Bucket } from "@cloudflare/workers-types"
import type {
  Analytics,
  AnalyticsFeatureMetadata,
  AnalyticsUsage,
  AnalyticsVerification,
} from "@unprice/analytics"
import type { EntitlementState } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
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
import migrations from "../../drizzle/migrations"

// Constants
const BATCH_SIZE = 1000
const METADATA_RETENTION_DAYS = 3
const STATE_KEY_PREFIX = "state:"
const SEEN_META_PREFIX = "seen_meta_"
const ACTIVE_CUSTOMERS_KEY = "tracked_do_keys"
const R2_MANIFEST_MAX_RETRIES = 5
const R2_MANIFEST_RETRY_BASE_MS = 50

// ─────────────────────────────────────────────────────────────────────────────
// R2 Lakehouse Types
// ─────────────────────────────────────────────────────────────────────────────

/** Descriptor for a raw data file in R2 */
interface R2FileDescriptor {
  key: string
  day: string // YYYY-MM-DD for filtering by date range
  minTs: number // earliest timestamp in file
  maxTs: number // latest timestamp in file
  count: number // number of records
  bytes: number // file size in bytes
}

/** Manifest for a single data type (usage or verification) - reduces race conditions under concurrency */
interface R2DataTypeManifest {
  projectId: string
  customerId: string
  updatedAt: string // ISO timestamp
  files: R2FileDescriptor[]
  compacted?: R2FileDescriptor[]
}

/** Customer metadata file structure (append-only, dimension table) */
interface R2CustomerMetadata {
  projectId: string
  customerId: string
  updatedAt: string
  entries: Array<{
    meta_id: number
    tags: string
    timestamp: number
    addedAt: string
  }>
}

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
  meta_id: number
  deleted: number
  project_id: string
  customer_id: string
  feature_slug: string
  request_id: string
  created_at: number
  idempotence_key: string
  // first-class analytics columns
  country: string
  region: string
  action: string | undefined
  key_id: string | undefined
}

interface TinybirdVerificationPayload {
  timestamp: number
  meta_id: number
  latency: number
  denied_reason: string | undefined
  allowed: number
  project_id: string
  customer_id: string
  feature_slug: string
  request_id: string
  created_at: number
  region: string
  // first-class analytics columns
  country: string
  action: string | undefined
  key_id: string | undefined
}

interface TinybirdMetadataPayload {
  timestamp: number
  project_id: string
  customer_id: string
  meta_id: number
  tags: string
}

// Processed record with metadata for internal use
interface ProcessedUsageRecord {
  record: UsageRecord
  metaId: number
  metadata: Record<string, unknown> | null
  country: string
  region: string
  action: string | undefined
  keyId: string | undefined
}

interface ProcessedVerificationRecord {
  record: Verification
  metaId: number
  region: string
  country: string
  action: string | undefined
  keyId: string | undefined
}

interface MetadataProcessingResult {
  usageRecords: ProcessedUsageRecord[]
  verificationRecords: ProcessedVerificationRecord[]
  uniqueMetadata: AnalyticsFeatureMetadata[]
  seenMetaSet: Set<string>
  todayKey: string
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
  private readonly lakehouse: R2Bucket | undefined

  // Memoized entitlement states for fast lookups
  private stateCache = new Map<string, EntitlementState>()
  private initialized = false
  private lastR2UsageId: string | null = null
  private lastR2VerificationId: number | null = null

  // Lazily initialized xxhash instance (WASM module)
  private xxhashInstance: XXHashAPI | null = null

  constructor(args: {
    storage: DurableObjectStorage
    state: DurableObjectState
    analytics: Analytics
    logger: Logger
    lakehouse?: R2Bucket
  }) {
    this.storage = args.storage
    this.state = args.state
    this.analytics = args.analytics
    this.logger = args.logger
    this.lakehouse = args.lakehouse
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

      await this.db
        .insert(schema.usageRecords)
        .values({
          id: record.id,
          customer_id: record.customer_id,
          feature_slug: record.feature_slug,
          usage: String(record.usage),
          timestamp: record.timestamp,
          created_at: record.created_at,
          metadata: record.metadata ? JSON.stringify(record.metadata) : null,
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
        // first-class analytics columns
        country: record.country ?? "UNK",
        region: record.region ?? "UNK",
        action: record.action ?? null,
        key_id: record.key_id ?? null,
      })

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("insertVerification", error)
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

      // 2. Process metadata (compute meta_id, extract unique metadata)
      const processed = await this.processMetadata(usageBatch.records, verificationBatch.records)

      // 3. Send to destinations in parallel (R2 is best-effort)
      const [_r2Result, usageResult, verificationResult, _metaResult] = await Promise.all([
        this.flushToR2(processed).catch((err) => {
          this.logger.error("R2 flush failed (best-effort)", { error: this.errorMessage(err) })
          return { success: false }
        }),
        this.ingestUsageToTinybird(processed.usageRecords),
        this.ingestVerificationsToTinybird(processed.verificationRecords),
        this.ingestMetadataToTinybird(processed.uniqueMetadata),
      ])

      // 4. Update seen metadata set
      if (processed.uniqueMetadata.length > 0) {
        await this.updateSeenMetaSet(processed.todayKey, processed.seenMetaSet)
      }

      // 5. Delete successfully processed records
      if (usageResult.success && usageBatch.firstId && usageBatch.lastId) {
        await this.deleteUsageRecordsBatch(usageBatch.firstId, usageBatch.lastId)
      }

      if (verificationResult.success && verificationBatch.firstId && verificationBatch.lastId) {
        await this.deleteVerificationRecordsBatch(
          verificationBatch.firstId,
          verificationBatch.lastId
        )
      }

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

        // Reinitialize
        await migrate(this.db, migrations)
        await this.loadStateCache()
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Metadata Processing
  // ─────────────────────────────────────────────────────────────────────────────

  private async processMetadata(
    usageRecords: UsageRecord[],
    verifications: Verification[]
  ): Promise<MetadataProcessingResult> {
    const todayKey = this.getTodayKey()
    const seenMetaSet = await this.getSeenMetaSet(todayKey)
    const uniqueMetadata: AnalyticsFeatureMetadata[] = []

    // Process usage records
    const processedUsage: ProcessedUsageRecord[] = []
    for (const record of usageRecords) {
      const metadata = this.parseMetadata(record.metadata)
      const { hash, json } = await this.computeMetaId(metadata)
      const metaId = Number(hash)
      const metaIdKey = hash.toString() // string key for Set deduplication

      if (hash !== BigInt(0) && !seenMetaSet.has(metaIdKey)) {
        seenMetaSet.add(metaIdKey)
        uniqueMetadata.push({
          meta_id: metaId,
          tags: json,
          project_id: record.project_id,
          customer_id: record.customer_id,
          timestamp: record.timestamp,
        })
      }

      // Extract first-class analytics fields from record columns
      processedUsage.push({
        record,
        metaId,
        metadata,
        country: record.country ?? "UNK",
        region: record.region ?? "UNK",
        action: record.action ?? undefined,
        keyId: record.key_id ?? undefined,
      })
    }

    // Process verifications
    const processedVerifications: ProcessedVerificationRecord[] = []
    for (const record of verifications) {
      const metadata = this.parseMetadata(record.metadata)
      const { hash, json } = await this.computeMetaId(metadata)
      const metaId = Number(hash)
      const metaIdKey = hash.toString() // string key for Set deduplication

      if (hash !== BigInt(0) && !seenMetaSet.has(metaIdKey)) {
        seenMetaSet.add(metaIdKey)
        uniqueMetadata.push({
          meta_id: metaId,
          tags: json,
          project_id: record.project_id,
          customer_id: record.customer_id,
          timestamp: record.timestamp,
        })
      }

      // Extract first-class analytics fields from record columns
      processedVerifications.push({
        record,
        metaId,
        region: record.region ?? "UNK",
        country: record.country ?? "UNK",
        action: record.action ?? undefined,
        keyId: record.key_id ?? undefined,
      })
    }

    return {
      usageRecords: processedUsage,
      verificationRecords: processedVerifications,
      uniqueMetadata,
      seenMetaSet,
      todayKey,
    }
  }

  private parseMetadata(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  private async computeMetaId(
    metadata: Record<string, unknown> | null
  ): Promise<{ hash: bigint; json: string }> {
    if (!metadata || Object.keys(metadata).length === 0) {
      return { hash: BigInt(0), json: "{}" }
    }

    // Sort keys for stable hashing
    const sortedKeys = Object.keys(metadata).sort()
    const normalized: Record<string, unknown> = {}
    for (const key of sortedKeys) {
      normalized[key] = metadata[key]
    }

    const json = JSON.stringify(normalized)
    const hasher = await this.getXxhash()

    return { hash: hasher.h64(json), json }
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
    records: ProcessedUsageRecord[]
  ): Promise<{ success: boolean }> {
    if (records.length === 0) return { success: true }

    try {
      const payload: TinybirdUsagePayload[] = records.map(
        ({ record, metaId, country, region, action, keyId }) => ({
          id: record.id,
          timestamp: record.timestamp,
          usage: Number(record.usage ?? 0),
          meta_id: metaId,
          deleted: record.deleted,
          project_id: record.project_id,
          customer_id: record.customer_id,
          feature_slug: record.feature_slug,
          request_id: record.request_id,
          created_at: record.created_at,
          idempotence_key: record.idempotence_key,
          // first-class analytics columns
          country,
          region,
          action,
          key_id: keyId,
        })
      )

      const result = await this.analytics.ingestFeaturesUsage(payload)

      // Verify all rows were processed (either successful or quarantined)
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0
      const total = successful + quarantined

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
    records: ProcessedVerificationRecord[]
  ): Promise<{ success: boolean }> {
    if (records.length === 0) return { success: true }

    try {
      const payload: TinybirdVerificationPayload[] = records.map(
        ({ record, metaId, region, country, action, keyId }) => ({
          timestamp: record.timestamp,
          meta_id: metaId,
          latency: record.latency ? Number(record.latency) : 0,
          denied_reason: record.denied_reason ?? undefined,
          allowed: record.allowed,
          project_id: record.project_id,
          customer_id: record.customer_id,
          feature_slug: record.feature_slug,
          request_id: record.request_id,
          created_at: record.created_at,
          region,
          // first-class analytics columns
          country,
          action,
          key_id: keyId,
        })
      )

      const result = await this.analytics.ingestFeaturesVerification(payload)

      // Verify all rows were processed
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0
      const total = successful + quarantined

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

  private async ingestMetadataToTinybird(
    metadata: AnalyticsFeatureMetadata[]
  ): Promise<{ success: boolean }> {
    if (metadata.length === 0) return { success: true }

    try {
      const payload: TinybirdMetadataPayload[] = metadata.map((m) => ({
        timestamp: m.timestamp,
        project_id: m.project_id,
        customer_id: m.customer_id,
        meta_id: m.meta_id,
        tags: m.tags,
      }))

      const result = await this.analytics.ingestMetadata(payload)

      // Verify all rows were processed
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0
      const total = successful + quarantined

      if (total >= metadata.length) {
        return { success: true }
      }

      this.logger.warn("Tinybird metadata ingestion incomplete", {
        expected: metadata.length,
        successful,
        quarantined,
      })
      return { success: false }
    } catch (error) {
      this.logger.error("Failed to ingest metadata to Tinybird", {
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

  /**
   * Retrieves the set of customer keys (project/customer) that this Durable Object
   * has actively tracked/flushed data for. Used to determine scope for compaction.
   */
  private async getTrackedDoKeys(): Promise<Set<string>> {
    const list = (await this.storage.get<string[]>(ACTIVE_CUSTOMERS_KEY)) ?? []
    return new Set(list)
  }

  /**
   * Updates the set of tracked customer keys.
   * Persisted in DO storage so the compaction job knows which manifests to check.
   */
  private async addTrackedDoKeys(keys: string[]): Promise<void> {
    const active = await this.getTrackedDoKeys()
    let changed = false
    for (const key of keys) {
      if (!active.has(key)) {
        active.add(key)
        changed = true
      }
    }
    if (changed) {
      await this.storage.put(ACTIVE_CUSTOMERS_KEY, Array.from(active))
    }
  }

  /**
   * Flushes processed usage, verification, and metadata records to R2.
   *
   * Strategy:
   * 1. Write raw NDJSON files (immutable batches) for usage and verifications.
   * 2. Update R2 manifests (usage/verification) using ETag CAS to point to new files.
   * 3. Write raw metadata updates and update metadata manifest.
   * 4. Update local state to track last flushed IDs (prevent double-flushing).
   *
   * @param processed The batch of processed records and metadata.
   */
  private async flushToR2(processed: MetadataProcessingResult): Promise<{ success: boolean }> {
    if (!this.lakehouse) return { success: true }

    try {
      // Filter out usage records that have already been flushed to R2
      const newUsageRecords = processed.usageRecords.filter((p) => {
        if (!this.lastR2UsageId) return true
        return p.record.id > this.lastR2UsageId
      })

      // Filter out verification records that have already been flushed to R2
      const newVerificationRecords = processed.verificationRecords.filter((p) => {
        if (this.lastR2VerificationId === null) return true
        return p.record.id > this.lastR2VerificationId
      })

      // If nothing new to flush, return early
      if (
        newUsageRecords.length === 0 &&
        newVerificationRecords.length === 0 &&
        processed.uniqueMetadata.length === 0
      ) {
        return { success: true }
      }

      const now = new Date()
      const dayString = now.toISOString().slice(0, 10) // YYYY-MM-DD

      // Collect file descriptors grouped by project/customer for manifest updates
      const filesByCustomer = new Map<
        string,
        { usage: R2FileDescriptor[]; verifications: R2FileDescriptor[] }
      >()

      const getOrCreateCustomerFiles = (projectId: string, customerId: string) => {
        const key = `${projectId}/${customerId}`
        let files = filesByCustomer.get(key)
        if (!files) {
          files = { usage: [], verifications: [] }
          filesByCustomer.set(key, files)
        }
        return files
      }

      // Phase 1: Write raw NDJSON files to R2
      // Upload usage records grouped by project/customer
      if (newUsageRecords.length > 0) {
        const usageGroups = this.groupByProjectCustomer(newUsageRecords.map((p) => p.record))
        const uploads: Promise<void>[] = []

        for (const [key, records] of usageGroups) {
          const [projectId, customerId] = key.split("/") as [string, string]
          const fileKey = this.getR2RawFileKey(projectId, customerId, now, "usage")
          const buffer = this.toNDJSON(records)

          // Compute min/max timestamps
          const timestamps = records.map((r) => r.timestamp).sort((a, b) => a - b)
          const minTs = timestamps[0]!
          const maxTs = timestamps[timestamps.length - 1]!

          // Track file descriptor for manifest update
          const customerFiles = getOrCreateCustomerFiles(projectId, customerId)
          customerFiles.usage.push({
            key: fileKey,
            day: dayString,
            minTs,
            maxTs,
            count: records.length,
            bytes: buffer.length,
          })

          uploads.push(
            this.lakehouse
              .put(fileKey, buffer, {
                httpMetadata: { contentType: "application/x-ndjson" },
              })
              .then(() => undefined)
          )
        }

        await Promise.all(uploads)
      }

      // Upload verification records grouped by project/customer
      if (newVerificationRecords.length > 0) {
        const verificationGroups = this.groupByProjectCustomer(
          newVerificationRecords.map((p) => p.record)
        )
        const uploads: Promise<void>[] = []

        for (const [key, records] of verificationGroups) {
          const [projectId, customerId] = key.split("/") as [string, string]
          const fileKey = this.getR2RawFileKey(projectId, customerId, now, "verification")
          const buffer = this.toNDJSON(records)

          // Compute min/max timestamps
          const timestamps = records.map((r) => r.timestamp).sort((a, b) => a - b)
          const minTs = timestamps[0]!
          const maxTs = timestamps[timestamps.length - 1]!

          // Track file descriptor for manifest update
          const customerFiles = getOrCreateCustomerFiles(projectId, customerId)
          customerFiles.verifications.push({
            key: fileKey,
            day: dayString,
            minTs,
            maxTs,
            count: records.length,
            bytes: buffer.length,
          })

          uploads.push(
            this.lakehouse
              .put(fileKey, buffer, {
                httpMetadata: { contentType: "application/x-ndjson" },
              })
              .then(() => undefined)
          )
        }

        await Promise.all(uploads)
      }

      // Phase 2: Update per-type manifests with ETag CAS (separate usage/verification to reduce race conditions)
      const manifestUpdates: Promise<void>[] = []
      const activeCustomersToUpdate: string[] = []

      for (const [key, files] of filesByCustomer) {
        const [projectId, customerId] = key.split("/") as [string, string]
        activeCustomersToUpdate.push(key)

        if (files.usage.length > 0) {
          manifestUpdates.push(this.updateR2UsageManifest(projectId, customerId, files.usage))
        }
        if (files.verifications.length > 0) {
          manifestUpdates.push(
            this.updateR2VerificationManifest(projectId, customerId, files.verifications)
          )
        }
      }

      await Promise.all(manifestUpdates)

      if (activeCustomersToUpdate.length > 0) {
        await this.addTrackedDoKeys(activeCustomersToUpdate)
      }

      // Phase 3: Update metadata
      if (processed.uniqueMetadata.length > 0) {
        const metadataByCustomer = this.groupByProjectCustomer(processed.uniqueMetadata)
        const metadataUpdates: Promise<void>[] = []
        const metadataKeysToAdd: string[] = []

        for (const [key, entries] of metadataByCustomer) {
          const [projectId, customerId] = key.split("/") as [string, string]
          metadataKeysToAdd.push(key)

          const rawFileKey = this.getR2RawFileKey(projectId, customerId, now, "metadata")
          const buffer = this.toNDJSON(
            entries.map((e) => ({
              meta_id: e.meta_id,
              tags: e.tags,
              timestamp: e.timestamp,
            }))
          )

          metadataUpdates.push(
            this.lakehouse
              .put(rawFileKey, buffer, {
                httpMetadata: { contentType: "application/x-ndjson" },
              })
              .then(() => {
                // Update metadata manifest
                return this.updateR2MetadataManifest(projectId, customerId, [
                  {
                    key: rawFileKey,
                    day: dayString,
                    minTs: Math.min(...entries.map((e) => e.timestamp)),
                    maxTs: Math.max(...entries.map((e) => e.timestamp)),
                    count: entries.length,
                    bytes: buffer.length,
                  },
                ])
              })
          )
        }

        await Promise.all(metadataUpdates)
        if (metadataKeysToAdd.length > 0) {
          await this.addTrackedDoKeys(metadataKeysToAdd)
        }
      }

      // Update state with the latest IDs we successfully flushed
      if (processed.usageRecords.length > 0) {
        const firstRecord = processed.usageRecords[0]
        if (firstRecord) {
          this.lastR2UsageId = firstRecord.record.id
        }
      }

      if (processed.verificationRecords.length > 0) {
        const lastRec = processed.verificationRecords[processed.verificationRecords.length - 1]
        if (lastRec) {
          this.lastR2VerificationId = lastRec.record.id
        }
      }

      return { success: true }
    } catch (error) {
      this.logger.error("Failed to flush to R2", { error: this.errorMessage(error) })
      return { success: false }
    }
  }

  private groupByProjectCustomer<T extends { project_id: string; customer_id: string }>(
    records: T[]
  ): Map<string, T[]> {
    const groups = new Map<string, T[]>()

    for (const record of records) {
      const key = `${record.project_id}/${record.customer_id}`
      const group = groups.get(key)
      if (group) {
        group.push(record)
      } else {
        groups.set(key, [record])
      }
    }

    return groups
  }

  private toNDJSON<T extends object>(records: T[]): Uint8Array {
    if (records.length === 0) return new Uint8Array()
    const ndjson = records.map((r) => JSON.stringify(r)).join("\n")
    return new TextEncoder().encode(ndjson)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // R2 Key Generation
  // ─────────────────────────────────────────────────────────────────────────────

  private getR2DayPath(projectId: string, customerId: string, date: Date): string {
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, "0")
    const day = String(date.getUTCDate()).padStart(2, "0")
    return `${projectId}/${customerId}/${year}/${month}/${day}`
  }

  /** Key for the Usage Manifest (one per customer) */
  private getR2UsageKey(projectId: string, customerId: string): string {
    return `${projectId}/${customerId}/usage_manifest.json`
  }

  /** Key for the Verification Manifest (one per customer) */
  private getR2VerificationKey(projectId: string, customerId: string): string {
    return `${projectId}/${customerId}/verification_manifest.json`
  }

  /** Key for the Metadata Manifest (one per customer) */
  private getR2MetadataManifestKey(projectId: string, customerId: string): string {
    return `${projectId}/${customerId}/metadata_manifest.json`
  }

  /** Key for the Master Metadata File (Dimension Table, one per customer) */
  private getR2MetadataKey(projectId: string, customerId: string): string {
    return `${projectId}/${customerId}/metadata.json`
  }

  /** Key for a raw NDJSON file within a daily partition */
  private getR2RawFileKey(
    projectId: string,
    customerId: string,
    date: Date,
    type: "usage" | "verification" | "metadata"
  ): string {
    const timestamp = date.getTime()
    return `${this.getR2DayPath(projectId, customerId, date)}/${type}_${timestamp}.ndjson`
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // R2 Manifest Operations (ETag CAS)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Update usage manifest with ETag CAS for concurrency safety.
   * Separate manifest per data type to reduce race conditions.
   * Retries on ETag mismatch up to R2_MANIFEST_MAX_RETRIES times.
   */
  private async updateR2UsageManifest(
    projectId: string,
    customerId: string,
    newFiles: R2FileDescriptor[]
  ): Promise<void> {
    if (!this.lakehouse || newFiles.length === 0) return
    await this.updateR2DataTypeManifest(
      this.getR2UsageKey(projectId, customerId),
      projectId,
      customerId,
      newFiles
    )
  }

  /**
   * Update verification manifest with ETag CAS for concurrency safety.
   * Separate manifest per data type to reduce race conditions.
   * Retries on ETag mismatch up to R2_MANIFEST_MAX_RETRIES times.
   */
  private async updateR2VerificationManifest(
    projectId: string,
    customerId: string,
    newFiles: R2FileDescriptor[]
  ): Promise<void> {
    if (!this.lakehouse || newFiles.length === 0) return
    await this.updateR2DataTypeManifest(
      this.getR2VerificationKey(projectId, customerId),
      projectId,
      customerId,
      newFiles
    )
  }

  /**
   * Update metadata manifest with ETag CAS.
   * Tracks all raw metadata files that need to be compacted into the master dimension table.
   */
  private async updateR2MetadataManifest(
    projectId: string,
    customerId: string,
    newFiles: R2FileDescriptor[]
  ): Promise<void> {
    if (!this.lakehouse || newFiles.length === 0) return
    await this.updateR2DataTypeManifest(
      this.getR2MetadataManifestKey(projectId, customerId),
      projectId,
      customerId,
      newFiles
    )
  }

  // removed duplicate getR2MetadataManifestKey

  /**
   * Core helper to update any manifest file with ETag CAS.
   * Handles creation if missing, appending new files, and optimistic locking.
   */
  private async updateR2DataTypeManifest(
    manifestKey: string,
    projectId: string,
    customerId: string,
    newFiles: R2FileDescriptor[]
  ): Promise<void> {
    for (let attempt = 0; attempt < R2_MANIFEST_MAX_RETRIES; attempt++) {
      // Read current manifest with ETag
      const existing = await this.lakehouse!.get(manifestKey)
      let manifest: R2DataTypeManifest
      let currentEtag: string | undefined

      if (existing) {
        manifest = (await existing.json()) as R2DataTypeManifest
        currentEtag = existing.etag
      } else {
        manifest = {
          projectId,
          customerId,
          updatedAt: new Date().toISOString(),
          files: [],
        }
      }

      const existingKeys = new Set(manifest.files.map((f) => f.key))
      let addedCount = 0
      for (const file of newFiles) {
        if (!existingKeys.has(file.key)) {
          manifest.files.push(file)
          addedCount++
        }
      }

      if (addedCount === 0) return

      manifest.updatedAt = new Date().toISOString()

      try {
        const content = JSON.stringify(manifest, null, 2)
        const httpMetadata = { contentType: "application/json" }
        if (currentEtag) {
          await this.lakehouse!.put(manifestKey, content, {
            httpMetadata,
            onlyIf: { etagMatches: currentEtag },
          })
        } else {
          await this.lakehouse!.put(manifestKey, content, { httpMetadata })
        }
        return
      } catch (error) {
        if (attempt < R2_MANIFEST_MAX_RETRIES - 1) {
          const backoffMs = R2_MANIFEST_RETRY_BASE_MS * 2 ** attempt
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }
        throw error
      }
    }
  }

  /**
   * Update customer metadata file (append-only, single file per customer)
   * Uses ETag CAS for concurrency safety
   */
  private async updateR2CustomerMetadata(
    projectId: string,
    customerId: string,
    newEntries: Array<{ meta_id: number; tags: string; timestamp: number }>
  ): Promise<void> {
    if (!this.lakehouse || newEntries.length === 0) return

    const metadataKey = this.getR2MetadataKey(projectId, customerId)

    for (let attempt = 0; attempt < R2_MANIFEST_MAX_RETRIES; attempt++) {
      // Read current metadata with ETag
      const existing = await this.lakehouse.get(metadataKey)
      let metadata: R2CustomerMetadata
      let currentEtag: string | undefined

      if (existing) {
        metadata = (await existing.json()) as R2CustomerMetadata
        currentEtag = existing.etag
      } else {
        metadata = {
          projectId,
          customerId,
          updatedAt: new Date().toISOString(),
          entries: [],
        }
      }

      // Build set of existing meta_ids for deduplication
      const existingMetaIds = new Set(metadata.entries.map((e) => e.meta_id))
      const now = new Date().toISOString()

      // Add only new entries
      let addedCount = 0
      for (const entry of newEntries) {
        if (!existingMetaIds.has(entry.meta_id)) {
          metadata.entries.push({
            ...entry,
            addedAt: now,
          })
          addedCount++
        }
      }

      // If nothing new to add, we're done
      if (addedCount === 0) {
        return
      }

      metadata.updatedAt = now

      // Write with ETag condition
      try {
        const content = JSON.stringify(metadata, null, 2)
        const httpMetadata = { contentType: "application/json" }

        if (currentEtag) {
          // Conditional put with ETag match
          await this.lakehouse.put(metadataKey, content, {
            httpMetadata,
            onlyIf: { etagMatches: currentEtag },
          })
        } else {
          // New metadata file - no condition
          await this.lakehouse.put(metadataKey, content, { httpMetadata })
        }
        return // Success
      } catch (error) {
        // ETag mismatch - retry with exponential backoff
        if (attempt < R2_MANIFEST_MAX_RETRIES - 1) {
          const backoffMs = R2_MANIFEST_RETRY_BASE_MS * 2 ** attempt
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }
        throw error
      }
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

  private async updateSeenMetaSet(date: string, metaIds: Set<string>): Promise<void> {
    const key = `${SEEN_META_PREFIX}${date}`
    await this.storage.put(key, Array.from(metaIds))
    await this.rotateSeenMetadata(date)
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

  /**
   * Compaction Trigger
   *
   * Orchestrates the daily compaction process for all active customers tracked by this DO.
   * Compaction merges many small raw NDJSON files into fewer, larger files to optimize read performance and reduce costs.
   */
  async compact(): Promise<void> {
    const active = await this.getTrackedDoKeys()
    for (const key of active) {
      const [projectId, customerId] = key.split("/") as [string, string]

      // Compact usage
      await this.compactManifest(projectId, customerId, "usage")

      // Compact verifications
      await this.compactManifest(projectId, customerId, "verification")

      // Compact metadata
      await this.compactMetadata(projectId, customerId)
    }
  }

  /**
   * Compacts raw event files (usage/verification) for a specific customer into daily consolidated files.
   *
   * Process:
   * 1. Reads the manifest to find days with raw files that haven't been compacted yet.
   * 2. For each day, reads all raw files, merges them, and writes a single `compact_<type>.ndjson` file.
   * 3. Updates the manifest to reference the new compact file and remove raw files.
   * 4. Deletes the old raw files from R2.
   *
   * Note: Skips "today" to avoid contention with active writing.
   */
  private async compactManifest(
    projectId: string,
    customerId: string,
    type: "usage" | "verification"
  ): Promise<void> {
    if (!this.lakehouse) return

    const manifestKey =
      type === "usage"
        ? this.getR2UsageKey(projectId, customerId)
        : this.getR2VerificationKey(projectId, customerId)

    const today = new Date().toISOString().slice(0, 10)

    // Retry loop for CAS
    for (let attempt = 0; attempt < R2_MANIFEST_MAX_RETRIES; attempt++) {
      const obj = await this.lakehouse.get(manifestKey)
      if (!obj) return

      const manifest = (await obj.json()) as R2DataTypeManifest
      const manifestEtag = obj.etag

      // Group raw files by day
      const filesByDay = new Map<string, R2FileDescriptor[]>()
      for (const file of manifest.files) {
        if (!filesByDay.has(file.day)) {
          filesByDay.set(file.day, [])
        }
        filesByDay.get(file.day)!.push(file)
      }

      const compactedDays = new Set(manifest.compacted?.map((c) => c.day) ?? [])
      const daysToCompact = Array.from(filesByDay.keys()).filter(
        (day) => day !== today && !compactedDays.has(day)
      )

      if (daysToCompact.length === 0) return

      // Compact one day at a time (to avoid huge operations)
      // We will update manifest after compacting ALL eligible days in this turn?
      // Or one by one? One by one is safer but slower.
      // Let's do all eligible days that we can process.
      // Actually, let's just do one day to be safe with execution time, or maybe a few.
      // For now, let's try to compact all pending days.

      const newCompactedFiles: R2FileDescriptor[] = []
      const rawFilesToDelete: Set<string> = new Set()

      for (const day of daysToCompact) {
        const rawFiles = filesByDay.get(day)!
        if (rawFiles.length === 0) continue

        // Read all raw files
        const allLines: string[] = []
        let minTs: number | null = null
        let maxTs: number | null = null
        let totalCount = 0

        for (const rawFile of rawFiles) {
          const fileObj = await this.lakehouse.get(rawFile.key)
          if (!fileObj) {
            this.logger.warn(`Missing raw file during compaction: ${rawFile.key}`)
            continue
          }

          const content = await fileObj.text()
          const lines = content
            .trim()
            .split("\n")
            .filter((l) => l.length > 0)
          allLines.push(...lines)

          if (minTs === null || rawFile.minTs < minTs) minTs = rawFile.minTs
          if (maxTs === null || rawFile.maxTs > maxTs) maxTs = rawFile.maxTs
          totalCount += rawFile.count
          rawFilesToDelete.add(rawFile.key)
        }

        if (allLines.length === 0) continue

        // Write compact file
        const date = new Date(day)
        const compactKey = `${this.getR2DayPath(projectId, customerId, date)}/compact_${type}.ndjson`
        const compactContent = `${allLines.join("\n")}\n`
        const compactBytes = new TextEncoder().encode(compactContent)

        await this.lakehouse.put(compactKey, compactBytes, {
          httpMetadata: { contentType: "application/x-ndjson" },
        })

        newCompactedFiles.push({
          key: compactKey,
          day,
          minTs: minTs!,
          maxTs: maxTs!,
          count: totalCount,
          bytes: compactBytes.length,
        })
      }

      if (newCompactedFiles.length === 0) return

      // Update manifest
      const newManifest: R2DataTypeManifest = {
        ...manifest,
        updatedAt: new Date().toISOString(),
        files: manifest.files.filter((f) => !rawFilesToDelete.has(f.key)),
        compacted: [...(manifest.compacted ?? []), ...newCompactedFiles],
      }

      try {
        await this.lakehouse.put(manifestKey, JSON.stringify(newManifest, null, 2), {
          httpMetadata: { contentType: "application/json" },
          onlyIf: { etagMatches: manifestEtag },
        })

        // Delete raw files after successful manifest update
        // We do this in background (no await) or strictly?
        // User snippet does it after.
        for (const key of rawFilesToDelete) {
          // Fire and forget delete to save time?
          // Or await to ensure cleanliness?
          // I'll await with catch.
          this.lakehouse.delete(key).catch((err) => {
            this.logger.warn(`Failed to delete raw file ${key}:`, { error: this.errorMessage(err) })
          })
        }

        return // Success
      } catch (error) {
        // ETag mismatch, retry
        if (attempt < R2_MANIFEST_MAX_RETRIES - 1) {
          const backoffMs = R2_MANIFEST_RETRY_BASE_MS * 2 ** attempt
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }
        this.logger.error(`Failed to update manifest after compaction: ${manifestKey}`, {
          error: this.errorMessage(error),
        })
      }
    }
  }

  /**
   * Compacts metadata files into the master dimension table.
   *
   * Process:
   * 1. Reads the metadata manifest to find pending raw metadata files.
   * 2. Reads the current master `metadata.json` (Dimension Table).
   * 3. Merges new entries into the master table, deduplicating by `meta_id`.
   * 4. Writes the updated master table using ETag CAS.
   * 5. Updates the manifest to remove processed files.
   * 6. Deletes processed raw files.
   */
  private async compactMetadata(projectId: string, customerId: string): Promise<void> {
    if (!this.lakehouse) return

    const manifestKey = this.getR2MetadataManifestKey(projectId, customerId)
    const masterKey = this.getR2MetadataKey(projectId, customerId)

    for (let attempt = 0; attempt < R2_MANIFEST_MAX_RETRIES; attempt++) {
      // 1. Read Manifest
      const manifestObj = await this.lakehouse.get(manifestKey)
      if (!manifestObj) return // No manifest means no new metadata files

      const manifest = (await manifestObj.json()) as R2DataTypeManifest
      const manifestEtag = manifestObj.etag

      if (manifest.files.length === 0) return

      // 2. Read Master File (if exists)
      const masterObj = await this.lakehouse.get(masterKey)
      let masterMetadata: R2CustomerMetadata
      let masterEtag: string | undefined

      if (masterObj) {
        masterMetadata = (await masterObj.json()) as R2CustomerMetadata
        masterEtag = masterObj.etag
      } else {
        masterMetadata = {
          projectId,
          customerId,
          updatedAt: new Date().toISOString(),
          entries: [],
        }
      }

      // 3. Read All Raw Files
      const newEntries: Array<{ meta_id: number; tags: string; timestamp: number }> = []
      const filesProcessed: Set<string> = new Set()

      for (const file of manifest.files) {
        const fileObj = await this.lakehouse.get(file.key)
        if (!fileObj) {
          this.logger.warn(`Missing raw metadata file: ${file.key}`)
          filesProcessed.add(file.key)
          continue
        }

        const content = await fileObj.text()
        const lines = content
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)

        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            newEntries.push(entry)
          } catch (e) {
            this.logger.warn(`Failed to parse metadata line in ${file.key}`, {
              error: this.errorMessage(e),
            })
          }
        }
        filesProcessed.add(file.key)
      }

      // 4. Merge into Master (Deduplicate)
      const existingMetaIds = new Set(masterMetadata.entries.map((e) => e.meta_id))
      const now = new Date().toISOString()
      let addedCount = 0

      for (const entry of newEntries) {
        if (!existingMetaIds.has(entry.meta_id)) {
          masterMetadata.entries.push({
            ...entry,
            addedAt: now,
          })
          existingMetaIds.add(entry.meta_id)
          addedCount++
        }
      }

      // 5. Write Master File (CAS)
      try {
        if (addedCount > 0) {
          masterMetadata.updatedAt = now
          const content = JSON.stringify(masterMetadata, null, 2)
          const httpMetadata = { contentType: "application/json" }

          if (masterEtag) {
            await this.lakehouse.put(masterKey, content, {
              httpMetadata,
              onlyIf: { etagMatches: masterEtag },
            })
          } else {
            await this.lakehouse.put(masterKey, content, { httpMetadata })
          }
        }
      } catch (error) {
        if (attempt < R2_MANIFEST_MAX_RETRIES - 1) {
          const backoffMs = R2_MANIFEST_RETRY_BASE_MS * 2 ** attempt
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }
        this.logger.error(`Failed to update master metadata file: ${masterKey}`, {
          error: this.errorMessage(error),
        })
        return
      }

      // 6. Update Manifest (Remove processed files) (CAS)
      const newManifest: R2DataTypeManifest = {
        ...manifest,
        updatedAt: new Date().toISOString(),
        files: manifest.files.filter((f) => !filesProcessed.has(f.key)),
      }

      try {
        await this.lakehouse.put(manifestKey, JSON.stringify(newManifest, null, 2), {
          httpMetadata: { contentType: "application/json" },
          onlyIf: { etagMatches: manifestEtag },
        })

        // 7. Delete Raw Files
        for (const key of filesProcessed) {
          this.lakehouse.delete(key).catch((err) => {
            this.logger.warn(`Failed to delete raw metadata file ${key}`, {
              error: this.errorMessage(err),
            })
          })
        }
        return
      } catch (error) {
        if (attempt < R2_MANIFEST_MAX_RETRIES - 1) {
          const backoffMs = R2_MANIFEST_RETRY_BASE_MS * 2 ** attempt
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }
        this.logger.error(`Failed to update metadata manifest: ${manifestKey}`, {
          error: this.errorMessage(error),
        })
      }
    }
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
