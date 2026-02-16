import type { LakehouseEventForSource } from "./registry"

export interface LakehouseCursorState {
  lastR2UsageId: string | null
  lastR2VerificationId: number | null
}

export type LakehouseUsageEvent = LakehouseEventForSource<"usage">
export type LakehouseVerificationEvent = LakehouseEventForSource<"verification">
export type LakehouseMetadataEvent = LakehouseEventForSource<"metadata">
export type LakehouseEntitlementSnapshotEvent = LakehouseEventForSource<"entitlement_snapshot">

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

export interface LakehouseService {
  flushRaw(params: LakehouseFlushInput): Promise<LakehouseFlushResult>
}
