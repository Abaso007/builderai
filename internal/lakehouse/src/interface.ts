import type { LakehouseSource } from "./schemas"

export interface LakehouseCursorState {
  lastR2UsageId: string | null
  lastR2VerificationId: number | null
}

export interface LakehouseUsageEvent {
  id: string
  event_date: string
  idempotence_key: string
  feature_slug: string
  request_id: string
  project_id: string
  customer_id: string
  timestamp: number
  metadata_id: string
  usage: number
  created_at: number
  deleted: number
  meta_id: string
  country: string
  region: string
  action: string | null
  key_id: string | null
  cost: number | null
  rate_amount: number | null
  rate_currency: string | null
  entitlement_snapshot_id: string | null
  entitlement_version: string | null
  entitlement_feature_type: string | null
  entitlement_limit: number | null
  entitlement_overage_strategy: string | null
  entitlement_effective_at: number | null
  entitlement_expires_at: number | null
  schema_version: number
}

export interface LakehouseVerificationEvent {
  event_id: number
  event_date: string
  project_id: string
  denied_reason: string | null
  allowed: number
  timestamp: number
  created_at: number
  latency: number
  feature_slug: string
  customer_id: string
  request_id: string
  metadata_id: string
  country: string
  region: string
  meta_id: string
  action: string | null
  key_id: string | null
  usage: number | null
  remaining: number | null
  entitlement_snapshot_id: string | null
  entitlement_version: string | null
  entitlement_feature_type: string | null
  entitlement_limit: number | null
  entitlement_overage_strategy: string | null
  entitlement_effective_at: number | null
  entitlement_expires_at: number | null
  schema_version: number
}

export interface LakehouseMetadataEvent {
  event_date: string
  project_id: string
  customer_id: string
  metadata_id: string
  meta_id: string
  tags: string
  timestamp: number
  schema_version: number
}

export interface LakehouseEntitlementSnapshotEvent {
  event_date?: string
  project_id: string
  customer_id: string
  [key: string]: unknown
}

export interface LakehouseFlushInput {
  cursorState: LakehouseCursorState
  usageRecords: LakehouseUsageEvent[]
  verificationRecords: LakehouseVerificationEvent[]
  metadataRecords: LakehouseMetadataEvent[]
  entitlementSnapshots: LakehouseEntitlementSnapshotEvent[]
}

export interface LakehouseFlushResult {
  success: boolean
  cursorState: LakehouseCursorState
}

export interface LakehouseManifestQuery {
  projectId: string
  sources: LakehouseSource[]
  days: string[]
  customerId?: string
}

export interface LakehouseManifestFile {
  key: string
  day: string
  source: LakehouseSource
  bytes: number
  etag?: string
  uploadedAt: string
  kind: "raw" | "compact"
  customerId?: string
}

export interface LakehouseFileObject {
  body: ReadableStream<Uint8Array>
  size: number
  etag?: string
  isCompacted: boolean
}

export interface LakehouseCompactionRequest {
  projectId: string
  source: LakehouseSource
  day: string
  deleteSourceFiles: boolean
}

export interface LakehouseCompactionResult {
  compacted: boolean
  skipped: boolean
  files: number
  lines: number
  bytes: number
  invalidLines: number
}

export interface LakehouseService {
  flushRaw(params: LakehouseFlushInput): Promise<LakehouseFlushResult>
  getManifestFiles(params: LakehouseManifestQuery): Promise<LakehouseManifestFile[]>
  getFileObject(key: string): Promise<LakehouseFileObject | null>
  listProjectsForDay(day: string): Promise<string[]>
  compactDaySource(params: LakehouseCompactionRequest): Promise<LakehouseCompactionResult>
}
