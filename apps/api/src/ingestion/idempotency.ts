import { MAX_EVENT_AGE_MS } from "@unprice/services/entitlements"

export const IDEMPOTENCY_LEASE_MS = 60_000
export const IDEMPOTENCY_RETENTION_MS = MAX_EVENT_AGE_MS
export const INGESTION_IDEMPOTENCY_SHARD_COUNT = 32

export function selectIdempotencyShardIndex(
  idempotencyKey: string,
  shardCount = INGESTION_IDEMPOTENCY_SHARD_COUNT
): number {
  let hash = 0

  for (let index = 0; index < idempotencyKey.length; index++) {
    hash = (hash * 31 + idempotencyKey.charCodeAt(index)) >>> 0
  }

  return hash % shardCount
}

export function buildIngestionIdempotencyShardName(params: {
  appEnv: string
  customerId: string
  idempotencyKey: string
  projectId: string
  shardCount?: number
}): string {
  return [
    "idem",
    params.appEnv,
    params.projectId,
    params.customerId,
    selectIdempotencyShardIndex(params.idempotencyKey, params.shardCount),
  ].join(":")
}
