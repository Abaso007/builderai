import type { AnalyticsFeatureMetadata } from "@unprice/analytics"
import type {
  LakehouseCursorState,
  LakehouseEntitlementSnapshotEvent,
  LakehouseFlushInput,
  LakehouseFlushResult,
  LakehouseMetadataEvent,
  LakehouseService,
  LakehouseUsageEvent,
  LakehouseVerificationEvent,
} from "@unprice/lakehouse"
import {
  LAKEHOUSE_INTERNAL_METADATA_KEYS,
  LAKEHOUSE_SCHEMA_VERSION,
  getLakehouseSourceEventZodSchema,
} from "@unprice/lakehouse"
import type { Logger } from "@unprice/logging"
import type { UsageRecord, Verification } from "~/db/types"

type IndexedSource = "usage" | "verification" | "metadata" | "entitlement_snapshot"

interface LakehouseProcessedUsageRecord {
  record: UsageRecord
  metaId: number
  country: string
  region: string
  action: string | undefined
  keyId: string | undefined
}

interface LakehouseProcessedVerificationRecord {
  record: Verification
  metaId: number
  region: string
  country: string
  action: string | undefined
  keyId: string | undefined
}

interface LakehouseMetadataProcessingResult {
  usageRecords: LakehouseProcessedUsageRecord[]
  verificationRecords: LakehouseProcessedVerificationRecord[]
  uniqueMetadata: AnalyticsFeatureMetadata[]
  seenMetaSet: Set<string>
  todayKey: string
}

interface LakehousePreparedPayload {
  cursorState: LakehouseCursorState
  usageRecords: LakehouseUsageEvent[]
  verificationRecords: LakehouseVerificationEvent[]
  metadataRecords: LakehouseMetadataEvent[]
  entitlementSnapshots: LakehouseEntitlementSnapshotEvent[]
  seenSnapshotSet: Set<string>
  seenSnapshotDate: string
}

interface ParsedEntitlementSnapshotRecord {
  id: string
  schemaVersion: number
  timestamp: number
  projectId: string
  customerId: string
  featureSlug: string
  featureType: string
  aggregationMethod: string
  mergingPolicy: string
  limit: number | null
  effectiveAt: number
  expiresAt: number | null
  version: string
  resetConfig: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  grants: Array<Record<string, unknown>>
}

export interface LakehouseMetadataBuildParams {
  usageRecords: UsageRecord[]
  verificationRecords: Verification[]
  seenMetaSet: Set<string>
  todayKey: string
  hashMetadataJson(metadataJson: string): Promise<bigint>
}

export interface LakehousePipelineBinding {
  send(records: unknown[]): Promise<void>
}

export interface LakehousePipelineBindingsBySource {
  usage: LakehousePipelineBinding
  verification: LakehousePipelineBinding
  metadata: LakehousePipelineBinding
  entitlement_snapshot: LakehousePipelineBinding
}

interface PipelineSender {
  send(records: unknown[]): Promise<void>
}

const INTERNAL_METADATA_KEYS = new Set<string>(LAKEHOUSE_INTERNAL_METADATA_KEYS)

function chunkRecords<T>(records: T[], chunkSize: number): T[][] {
  if (records.length === 0) {
    return []
  }

  const chunks: T[][] = []
  for (let i = 0; i < records.length; i += chunkSize) {
    chunks.push(records.slice(i, i + chunkSize))
  }
  return chunks
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function toVerificationCursorValue(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return null
  }
  return parsed
}

function toEventDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseEntitlementSnapshot(raw: string | null): ParsedEntitlementSnapshotRecord | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") {
      return null
    }

    const record = parsed as Record<string, unknown>
    const snapshotId = record.id
    const projectId = record.project_id
    const customerId = record.customer_id
    const featureSlug = record.feature_slug

    if (
      typeof snapshotId !== "string" ||
      typeof projectId !== "string" ||
      typeof customerId !== "string" ||
      typeof featureSlug !== "string"
    ) {
      return null
    }

    const resetConfig =
      record.reset_config && typeof record.reset_config === "object"
        ? (record.reset_config as Record<string, unknown>)
        : null

    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : null

    const grants = Array.isArray(record.grants)
      ? record.grants.filter((entry) => !!entry && typeof entry === "object")
      : []

    return {
      id: snapshotId,
      schemaVersion: toFiniteNumber(record.schema_version) ?? 1,
      timestamp: toFiniteNumber(record.timestamp) ?? Date.now(),
      projectId: projectId,
      customerId: customerId,
      featureSlug: featureSlug,
      featureType: typeof record.feature_type === "string" ? record.feature_type : "unknown",
      aggregationMethod:
        typeof record.aggregation_method === "string" ? record.aggregation_method : "sum",
      mergingPolicy: typeof record.merging_policy === "string" ? record.merging_policy : "sum",
      limit: record.limit === null ? null : toFiniteNumber(record.limit),
      effectiveAt: toFiniteNumber(record.effective_at) ?? 0,
      expiresAt: record.expires_at === null ? null : toFiniteNumber(record.expires_at),
      version: typeof record.version === "string" ? record.version : "",
      resetConfig: resetConfig,
      metadata,
      grants: grants as Array<Record<string, unknown>>,
    }
  } catch {
    return null
  }
}

function collectEntitlementSnapshots(params: {
  usageRecords: LakehouseProcessedUsageRecord[]
  verificationRecords: LakehouseProcessedVerificationRecord[]
}): ParsedEntitlementSnapshotRecord[] {
  const snapshots = new Map<string, ParsedEntitlementSnapshotRecord>()

  const addSnapshot = (record: UsageRecord | Verification) => {
    const parsed = parseEntitlementSnapshot(record.entitlement_snapshot)
    if (!parsed) {
      return
    }

    const snapshotId = parsed.id
    if (!snapshotId || snapshots.has(snapshotId)) {
      return
    }

    snapshots.set(snapshotId, {
      ...parsed,
      id: snapshotId,
      projectId: record.project_id,
      customerId: record.customer_id,
      featureSlug: record.feature_slug,
    })
  }

  for (const { record } of params.usageRecords) {
    addSnapshot(record)
  }
  for (const { record } of params.verificationRecords) {
    addSnapshot(record)
  }

  return Array.from(snapshots.values())
}

function parseMetadataPayload(tags: string): unknown {
  try {
    return JSON.parse(tags)
  } catch {
    return { tags }
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function extractTagMetadata(
  metadata: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!metadata) {
    return null
  }

  const tagEntries = Object.entries(metadata).filter(([key]) => !INTERNAL_METADATA_KEYS.has(key))
  if (tagEntries.length === 0) {
    return null
  }

  return Object.fromEntries(tagEntries)
}

function toStableMetadataJson(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return "{}"
  }

  const sortedKeys = Object.keys(metadata).sort()
  const normalized: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    normalized[key] = metadata[key]
  }
  return JSON.stringify(normalized)
}

export async function buildLakehouseMetadataProcessingResult(
  params: LakehouseMetadataBuildParams
): Promise<LakehouseMetadataProcessingResult> {
  const uniqueMetadata: AnalyticsFeatureMetadata[] = []
  const processedUsage: LakehouseProcessedUsageRecord[] = []
  const processedVerifications: LakehouseProcessedVerificationRecord[] = []

  for (const record of params.usageRecords) {
    const metadata = extractTagMetadata(parseMetadata(record.metadata))
    const metadataJson = toStableMetadataJson(metadata)
    const hash = metadataJson === "{}" ? BigInt(0) : await params.hashMetadataJson(metadataJson)
    const metaId = Number(hash)
    const metaIdKey = hash.toString()

    if (hash !== BigInt(0) && !params.seenMetaSet.has(metaIdKey)) {
      params.seenMetaSet.add(metaIdKey)
      uniqueMetadata.push({
        meta_id: metaId,
        tags: metadataJson,
        project_id: record.project_id,
        customer_id: record.customer_id,
        timestamp: record.timestamp,
      })
    }

    processedUsage.push({
      record,
      metaId,
      country: record.country ?? "UNK",
      region: record.region ?? "UNK",
      action: record.action ?? undefined,
      keyId: record.key_id ?? undefined,
    })
  }

  for (const record of params.verificationRecords) {
    const metadata = extractTagMetadata(parseMetadata(record.metadata))
    const metadataJson = toStableMetadataJson(metadata)
    const hash = metadataJson === "{}" ? BigInt(0) : await params.hashMetadataJson(metadataJson)
    const metaId = Number(hash)
    const metaIdKey = hash.toString()

    if (hash !== BigInt(0) && !params.seenMetaSet.has(metaIdKey)) {
      params.seenMetaSet.add(metaIdKey)
      uniqueMetadata.push({
        meta_id: metaId,
        tags: metadataJson,
        project_id: record.project_id,
        customer_id: record.customer_id,
        timestamp: record.timestamp,
      })
    }

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
    seenMetaSet: params.seenMetaSet,
    todayKey: params.todayKey,
  }
}

export function buildLakehousePreparedPayload(params: {
  processed: LakehouseMetadataProcessingResult
  cursorState: LakehouseCursorState
  seenSnapshotSet: Set<string>
  seenSnapshotDate: string
}): LakehousePreparedPayload {
  const newUsageRecords = params.processed.usageRecords.filter((record) => {
    if (!params.cursorState.lastR2UsageId) return true
    return record.record.id > params.cursorState.lastR2UsageId
  })

  const newVerificationRecords = params.processed.verificationRecords.filter((record) => {
    if (params.cursorState.lastR2VerificationId === null) return true
    return record.record.id > params.cursorState.lastR2VerificationId
  })

  const entitlementSnapshots = collectEntitlementSnapshots({
    usageRecords: newUsageRecords,
    verificationRecords: newVerificationRecords,
  })

  const newEntitlementSnapshots = entitlementSnapshots.filter((snapshot) => {
    if (params.seenSnapshotSet.has(snapshot.id)) {
      return false
    }
    params.seenSnapshotSet.add(snapshot.id)
    return true
  })

  const usageRecords: LakehouseUsageEvent[] = newUsageRecords.map(
    ({ record, metaId, region, action, keyId, country }) => ({
      id: record.id,
      event_date: toEventDate(record.timestamp),
      request_id: record.request_id,
      project_id: record.project_id,
      customer_id: record.customer_id,
      timestamp: record.timestamp,
      allowed: record.deleted === 0,
      idempotence_key: record.idempotence_key,
      feature_slug: record.feature_slug,
      usage: Number(record.usage ?? 0),
      entitlement_id: record.entitlement_snapshot_id ?? "",
      deleted: record.deleted,
      meta_id: String(metaId),
      country: country ?? record.country ?? "UNK",
      region: region ?? record.region ?? "UNK",
      action: action ?? record.action ?? undefined,
      key_id: keyId ?? record.key_id ?? undefined,
      unit_of_measure: "unit",
      cost:
        record.cost != null && Number.isFinite(Number(record.cost))
          ? Number(record.cost)
          : undefined,
      rate_amount:
        record.rate_amount != null && Number.isFinite(Number(record.rate_amount))
          ? Number(record.rate_amount)
          : undefined,
      rate_currency: record.rate_currency ?? undefined,
      schema_version: LAKEHOUSE_SCHEMA_VERSION,
    })
  )

  const verificationRecords: LakehouseVerificationEvent[] = newVerificationRecords.map(
    ({ record, metaId, region, action, keyId, country }) => ({
      id: String(record.id),
      event_date: toEventDate(record.timestamp),
      project_id: record.project_id,
      denied_reason: record.denied_reason ?? undefined,
      allowed: record.allowed,
      timestamp: record.timestamp,
      latency: record.latency ? Number(record.latency) : undefined,
      feature_slug: record.feature_slug,
      customer_id: record.customer_id,
      request_id: record.request_id,
      country: country ?? record.country ?? "UNK",
      region: region ?? record.region ?? "UNK",
      meta_id: String(metaId),
      action: action ?? record.action ?? undefined,
      key_id: keyId ?? record.key_id ?? undefined,
      usage:
        record.usage != null && Number.isFinite(Number(record.usage))
          ? Number(record.usage)
          : undefined,
      remaining:
        record.remaining != null && Number.isFinite(Number(record.remaining))
          ? Number(record.remaining)
          : undefined,
      entitlement_id: record.entitlement_snapshot_id ?? undefined,
      schema_version: LAKEHOUSE_SCHEMA_VERSION,
    })
  )

  const metadataRecords: LakehouseMetadataEvent[] = params.processed.uniqueMetadata.map(
    (entry) => ({
      id: String(entry.meta_id),
      event_date: toEventDate(entry.timestamp),
      project_id: entry.project_id,
      customer_id: entry.customer_id,
      payload: parseMetadataPayload(entry.tags),
      timestamp: entry.timestamp,
      schema_version: LAKEHOUSE_SCHEMA_VERSION,
    })
  )

  const entitlementSnapshotsRecords: LakehouseEntitlementSnapshotEvent[] =
    newEntitlementSnapshots.map(
      (snapshot): LakehouseEntitlementSnapshotEvent => ({
        id: snapshot.id,
        event_date: toEventDate(snapshot.timestamp),
        project_id: snapshot.projectId,
        customer_id: snapshot.customerId,
        timestamp: snapshot.timestamp,
        feature_slug: snapshot.featureSlug,
        feature_type: snapshot.featureType,
        unit_of_measure: "unit",
        reset_config: snapshot.resetConfig ?? undefined,
        aggregation_method: snapshot.aggregationMethod,
        merging_policy: snapshot.mergingPolicy,
        limit: snapshot.limit ?? undefined,
        effective_at: snapshot.effectiveAt,
        expires_at: snapshot.expiresAt ?? undefined,
        version: snapshot.version,
        grants: snapshot.grants,
        metadata: snapshot.metadata ?? undefined,
        schema_version: snapshot.schemaVersion ?? LAKEHOUSE_SCHEMA_VERSION,
      })
    )

  return {
    cursorState: params.cursorState,
    usageRecords,
    verificationRecords,
    metadataRecords,
    entitlementSnapshots: entitlementSnapshotsRecords,
    seenSnapshotSet: params.seenSnapshotSet,
    seenSnapshotDate: params.seenSnapshotDate,
  }
}

class BindingLakehousePipelineSender implements PipelineSender {
  private readonly binding: LakehousePipelineBinding

  constructor(binding: LakehousePipelineBinding) {
    this.binding = binding
  }

  public async send(records: unknown[]): Promise<void> {
    await this.binding.send(records)
  }
}

export class CloudflarePipelineLakehouseService implements LakehouseService {
  private readonly sourceSenders: Record<IndexedSource, PipelineSender>
  private readonly batchSize: number
  private readonly logger: Logger

  constructor(params: {
    logger: Logger
    pipelines: LakehousePipelineBindingsBySource
    batchSize?: number
  }) {
    this.logger = params.logger
    this.batchSize = Math.max(1, params.batchSize ?? 500)

    this.sourceSenders = {
      usage: new BindingLakehousePipelineSender(params.pipelines.usage),
      verification: new BindingLakehousePipelineSender(params.pipelines.verification),
      metadata: new BindingLakehousePipelineSender(params.pipelines.metadata),
      entitlement_snapshot: new BindingLakehousePipelineSender(
        params.pipelines.entitlement_snapshot
      ),
    }
  }

  public async flushRaw(params: LakehouseFlushInput): Promise<LakehouseFlushResult> {
    try {
      const newUsageRecords = params.usageRecords.filter((record) => {
        if (!params.cursorState.lastR2UsageId) {
          return true
        }
        return record.id > params.cursorState.lastR2UsageId
      })

      const newVerificationRecords = params.verificationRecords.filter((record) => {
        if (params.cursorState.lastR2VerificationId === null) {
          return true
        }
        const cursorValue = toVerificationCursorValue(record.id)
        if (cursorValue === null) {
          return false
        }
        return cursorValue > params.cursorState.lastR2VerificationId
      })

      if (
        newUsageRecords.length === 0 &&
        newVerificationRecords.length === 0 &&
        params.metadataRecords.length === 0 &&
        params.entitlementSnapshots.length === 0
      ) {
        return {
          success: true,
          cursorState: params.cursorState,
        }
      }

      const sourceBatches: Record<IndexedSource, unknown[]> = {
        usage: this.canonicalizeRecords("usage", newUsageRecords),
        verification: this.canonicalizeRecords("verification", newVerificationRecords),
        metadata: this.canonicalizeRecords("metadata", params.metadataRecords),
        entitlement_snapshot: this.canonicalizeRecords(
          "entitlement_snapshot",
          params.entitlementSnapshots
        ),
      }

      await Promise.all(
        (Object.keys(sourceBatches) as IndexedSource[]).map((source) =>
          this.sendInChunks(source, sourceBatches[source])
        )
      )

      const nextUsageId =
        newUsageRecords.length > 0
          ? newUsageRecords.reduce(
              (max, item) => (item.id > max ? item.id : max),
              newUsageRecords[0]!.id
            )
          : params.cursorState.lastR2UsageId

      const nextVerificationId =
        newVerificationRecords.length > 0
          ? newVerificationRecords.reduce((max, item) => {
              const parsed = toVerificationCursorValue(item.id)
              if (parsed === null) {
                return max
              }
              return parsed > max ? parsed : max
            }, params.cursorState.lastR2VerificationId ?? 0)
          : params.cursorState.lastR2VerificationId

      return {
        success: true,
        cursorState: {
          lastR2UsageId: nextUsageId,
          lastR2VerificationId: nextVerificationId,
        },
      }
    } catch (error) {
      this.logger.error("Failed to flush to lakehouse pipeline", {
        error: error instanceof Error ? error.message : "unknown",
      })

      return {
        success: false,
        cursorState: params.cursorState,
      }
    }
  }

  private canonicalizeRecords(
    source: IndexedSource,
    records: unknown[]
  ): Record<string, unknown>[] {
    if (records.length === 0) {
      return []
    }

    const schema = getLakehouseSourceEventZodSchema(source)
    const accepted: Record<string, unknown>[] = []
    const rejectReasons = new Map<string, number>()

    for (const raw of records) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0]
        const path = firstIssue?.path?.length ? firstIssue.path.join(".") : "record"
        const reason = `${path}: ${firstIssue?.message ?? "invalid"}`
        rejectReasons.set(reason, (rejectReasons.get(reason) ?? 0) + 1)
        continue
      }

      accepted.push(parsed.data as Record<string, unknown>)
    }

    const rejectedCount = records.length - accepted.length
    if (rejectedCount > 0) {
      const sortedReasons = Object.fromEntries(
        Array.from(rejectReasons.entries()).sort(([a], [b]) => a.localeCompare(b))
      )

      this.logger.warn("Lakehouse records rejected by strict schema validation", {
        source,
        total: records.length,
        accepted: accepted.length,
        rejected: rejectedCount,
        reasons: JSON.stringify(sortedReasons),
      })
    }

    return accepted
  }

  private async sendInChunks(source: IndexedSource, records: unknown[]): Promise<void> {
    if (records.length === 0) {
      return
    }

    const chunks = chunkRecords(records, this.batchSize)
    const sender = this.sourceSenders[source]
    for (const chunk of chunks) {
      await sender.send(chunk)
    }
  }
}
