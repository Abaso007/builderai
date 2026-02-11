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
import { getLakehouseRawKey } from "~/util/lakehouse"
import migrations from "../../drizzle/migrations"

// Constants
const BATCH_SIZE = 1000
const METADATA_RETENTION_DAYS = 3
const STATE_KEY_PREFIX = "state:"
const SEEN_META_PREFIX = "seen_meta_"
const CURSOR_KEY = "cursor_state"
const INTERNAL_METADATA_KEYS = new Set([
  "cost",
  "rate",
  "rate_amount",
  "rate_currency",
  "rate_unit_size",
  "usage",
  "remaining",
])

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

interface CursorState {
  lastTinybirdUsageId: string | null
  lastR2UsageId: string | null
  lastTinybirdVerificationId: number | null
  lastR2VerificationId: number | null
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
      const [r2Result, usageResult, verificationResult, _metaResult] = await Promise.all([
        this.flushToR2(processed).catch((err) => {
          this.logger.error("R2 flush failed (best-effort)", { error: this.errorMessage(err) })
          return { success: false }
        }),
        this.ingestUsageToTinybird(usageForTinybird),
        this.ingestVerificationsToTinybird(verificationForTinybird),
        this.ingestMetadataToTinybird(processed.uniqueMetadata),
      ])

      // 5. Update cursors based on successful uploads
      let cursorsChanged = false

      if (usageResult.success && usageForTinybird.length > 0) {
        // Usage is DESC, so first record has highest ID
        const maxId = usageForTinybird[0]?.record.id
        if (
          maxId &&
          (!this.cursors.lastTinybirdUsageId || maxId > this.cursors.lastTinybirdUsageId)
        ) {
          this.cursors.lastTinybirdUsageId = maxId
          cursorsChanged = true
        }
      }

      if (verificationResult.success && verificationForTinybird.length > 0) {
        // Verification is ASC, so last record has highest ID
        const maxId = verificationForTinybird[verificationForTinybird.length - 1]?.record.id
        if (
          maxId !== undefined &&
          (this.cursors.lastTinybirdVerificationId === null ||
            maxId > this.cursors.lastTinybirdVerificationId)
        ) {
          this.cursors.lastTinybirdVerificationId = maxId
          cursorsChanged = true
        }
      }

      // R2 cursors are updated inside flushToR2, but we need to persist them
      if (r2Result.success) {
        cursorsChanged = true
      }

      if (cursorsChanged) {
        await this.saveCursors()
      }

      // 6. Update seen metadata set
      if (processed.uniqueMetadata.length > 0) {
        await this.updateSeenMetaSet(processed.todayKey, processed.seenMetaSet)
      }

      // 7. Delete records that have been safely persisted to BOTH destinations
      // For Usage (DESC): We can delete if both cursors have advanced past the batch
      if (usageBatch.firstId && usageBatch.lastId) {
        const tbSafe =
          this.cursors.lastTinybirdUsageId !== null &&
          this.cursors.lastTinybirdUsageId >= usageBatch.firstId
        const r2Safe =
          this.cursors.lastR2UsageId !== null && this.cursors.lastR2UsageId >= usageBatch.firstId

        if (tbSafe && r2Safe) {
          await this.deleteUsageRecordsBatch(usageBatch.firstId, usageBatch.lastId)
        }
      }

      // For Verification (ASC): We can delete if both cursors have advanced past the batch
      if (verificationBatch.firstId !== null && verificationBatch.lastId !== null) {
        const tbSafe =
          this.cursors.lastTinybirdVerificationId !== null &&
          this.cursors.lastTinybirdVerificationId >= verificationBatch.lastId
        const r2Safe =
          this.cursors.lastR2VerificationId !== null &&
          this.cursors.lastR2VerificationId >= verificationBatch.lastId

        if (tbSafe && r2Safe) {
          await this.deleteVerificationRecordsBatch(
            verificationBatch.firstId,
            verificationBatch.lastId
          )
        }
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
      const metadata = this.extractTagMetadata(this.parseMetadata(record.metadata))
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
      const metadata = this.extractTagMetadata(this.parseMetadata(record.metadata))
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

  private extractTagMetadata(
    metadata: Record<string, unknown> | null
  ): Record<string, unknown> | null {
    if (!metadata) return null

    const tagEntries = Object.entries(metadata).filter(([key]) => !INTERNAL_METADATA_KEYS.has(key))
    if (tagEntries.length === 0) return null

    return Object.fromEntries(tagEntries)
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

      if (quarantined > 0) {
        this.logger.warn("Tinybird metadata rows quarantined", {
          expected: metadata.length,
          successful,
          quarantined,
        })
      }

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
   * Flushes processed usage, verification, and metadata records to R2.
   *
   * Strategy:
   * 1. Write raw NDJSON files (immutable batches) for usage, verifications, and metadata.
   * 2. Leave compaction/indexing to a separate lakehouse compactor endpoint.
   * 3. Update local state to track last flushed IDs (prevent double-flushing).
   *
   * @param processed The batch of processed records and metadata.
   */
  private async flushToR2(processed: MetadataProcessingResult): Promise<{ success: boolean }> {
    if (!this.lakehouse) {
      this.logger.warn("R2 lakehouse not configured; skipping flush to R2", {
        usageRecords: processed.usageRecords.length,
        verificationRecords: processed.verificationRecords.length,
      })
      return { success: true }
    }

    try {
      // Filter out usage records that have already been flushed to R2
      const newUsageRecords = processed.usageRecords.filter((p) => {
        if (!this.cursors.lastR2UsageId) return true
        return p.record.id > this.cursors.lastR2UsageId
      })

      // Filter out verification records that have already been flushed to R2
      const newVerificationRecords = processed.verificationRecords.filter((p) => {
        if (this.cursors.lastR2VerificationId === null) return true
        return p.record.id > this.cursors.lastR2VerificationId
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
      const uploads: Promise<void>[] = []

      // Phase 1: Write raw NDJSON files to R2 (include meta_id so lakehouse can JOIN with metadata)
      // Upload usage records grouped by project/customer; payload includes meta_id from processed records
      if (newUsageRecords.length > 0) {
        const usagePayloads = newUsageRecords.map(
          ({ record, metaId, region, action, keyId, country }) => ({
            id: record.id,
            idempotence_key: record.idempotence_key,
            feature_slug: record.feature_slug,
            request_id: record.request_id,
            project_id: record.project_id,
            customer_id: record.customer_id,
            timestamp: record.timestamp,
            usage: Number(record.usage ?? 0),
            created_at: record.created_at,
            deleted: record.deleted,
            meta_id: String(metaId),
            country: country ?? record.country ?? "UNK",
            region: region ?? record.region ?? "UNK",
            action: action ?? record.action ?? null,
            key_id: keyId ?? record.key_id ?? null,
          })
        )
        const usageGroups = this.groupByProjectCustomer(usagePayloads)
        for (const [key, records] of usageGroups) {
          const [projectId, customerId] = key.split("/") as [string, string]
          const fileKey = this.getR2RawFileKey(projectId, customerId, dayString, now, "usage")
          const buffer = this.toNDJSON(records)

          uploads.push(
            this.lakehouse
              .put(fileKey, buffer, {
                httpMetadata: { contentType: "application/x-ndjson" },
              })
              .then(() => undefined)
          )
        }
      }

      // Upload verification records; payload includes meta_id from processed records
      if (newVerificationRecords.length > 0) {
        const verificationPayloads = newVerificationRecords.map(
          ({ record, metaId, region, action, keyId, country }) => ({
            project_id: record.project_id,
            denied_reason: record.denied_reason ?? null,
            allowed: record.allowed,
            timestamp: record.timestamp,
            created_at: record.created_at,
            latency: record.latency ? Number(record.latency) : 0,
            feature_slug: record.feature_slug,
            customer_id: record.customer_id,
            request_id: record.request_id,
            country: country ?? record.country ?? "UNK",
            region: region ?? record.region ?? "UNK",
            meta_id: String(metaId),
            action: action ?? record.action ?? null,
            key_id: keyId ?? record.key_id ?? null,
          })
        )
        const verificationGroups = this.groupByProjectCustomer(verificationPayloads)
        for (const [key, records] of verificationGroups) {
          const [projectId, customerId] = key.split("/") as [string, string]
          const fileKey = this.getR2RawFileKey(
            projectId,
            customerId,
            dayString,
            now,
            "verification"
          )
          const buffer = this.toNDJSON(records)

          uploads.push(
            this.lakehouse
              .put(fileKey, buffer, {
                httpMetadata: { contentType: "application/x-ndjson" },
              })
              .then(() => undefined)
          )
        }
      }

      // Upload metadata (raw NDJSON)
      if (processed.uniqueMetadata.length > 0) {
        const metadataByCustomer = this.groupByProjectCustomer(processed.uniqueMetadata)

        for (const [key, entries] of metadataByCustomer) {
          const [projectId, customerId] = key.split("/") as [string, string]
          const rawFileKey = this.getR2RawFileKey(projectId, customerId, dayString, now, "metadata")
          const buffer = this.toNDJSON(
            entries.map((e) => ({
              meta_id: String(e.meta_id),
              tags: e.tags,
              timestamp: e.timestamp,
            }))
          )

          uploads.push(
            this.lakehouse
              .put(rawFileKey, buffer, {
                httpMetadata: { contentType: "application/x-ndjson" },
              })
              .then(() => undefined)
          )
        }
      }

      if (uploads.length > 0) {
        await Promise.all(uploads)
      }

      // Update state only with IDs we actually flushed (batch order: usage DESC, verification ASC)
      if (newUsageRecords.length > 0) {
        const lastFlushedUsage = newUsageRecords[0]!
        this.cursors.lastR2UsageId = lastFlushedUsage.record.id
      }
      if (newVerificationRecords.length > 0) {
        const lastFlushedVerification = newVerificationRecords[newVerificationRecords.length - 1]!
        this.cursors.lastR2VerificationId = lastFlushedVerification.record.id
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

  /** Key for a raw NDJSON file within a daily partition (project-level lakehouse) */
  private getR2RawFileKey(
    projectId: string,
    customerId: string,
    day: string,
    date: Date,
    type: "usage" | "verification" | "metadata"
  ): string {
    const timestamp = date.getTime()
    const suffix = `${timestamp}-${customerId}`
    return getLakehouseRawKey(projectId, type, day, customerId, suffix)
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
