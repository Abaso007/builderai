# Canonical Ingestion Ledger

## Context

The current ingestion pipeline has two reliability gaps:

1. **Audit publish is fire-and-forget.** `publishPipelineEvent()` calls `pipelineEvents.send()` inline. If it fails, the audit row is lost permanently. There is no retry or outbox.
2. **Per-message DO overhead.** Every queued message makes 2 Durable Object calls (`begin()` + `complete()`) to IngestionIdempotencyDO. For a batch of N messages, that's 2N DO round-trips even though EntitlementWindowDO already guarantees usage correctness via its own idempotency.
3. **Sync path blocks on publish.** `ingestFeatureSync()` awaits `publishOutcome()` → `publishPipelineEvent()` → `pipelineEvents.send()` before returning the HTTP response, adding latency for a non-critical write.

The goal is a reliable audit trail in R2 with fewer moving parts, fewer DO calls, and zero added sync latency.

## Design

### Core idea: outbox-driven ledger DO

Replace `IngestionIdempotencyDO` with `IngestionLedgerDO`. Same 32 shards, same hash function. Two changes:

1. **One method instead of three.** `commit(entries[])` replaces begin/complete/abort. No lease state, no "busy" signal. Batched per shard after the customer group finishes processing.
2. **Outbox for R2 publish.** The DO alarm publishes unpublished rows to `PIPELINE_EVENTS` in batches, then marks them published. Replaces the fire-and-forget inline publish.

### Why this is safe

- **Usage correctness**: EntitlementWindowDO's own `idempotency_keys` table (keyed by eventId) already prevents double-counting. It was always the correctness layer. The outer idempotency DO was defense-in-depth for retry short-circuiting, not correctness.
- **Concurrent retries**: If a message retries while the original is still processing, both hit EntitlementWindowDO which returns the cached result. Both call `commit()` — the second is a no-op via `INSERT ON CONFLICT DO NOTHING`. No correctness issue, minor wasted work.
- **Commit failure**: If `commit()` fails after EntitlementWindowDO applied usage, the message is still acked (usage is durable). The audit row is missing but can be retried. A `commit_failed` counter alerts on this.

### What the ledger enables beyond dedup

- **Replay**: Ledger rows contain the full pipeline event payload. If R2 publish fails persistently, a manual replay job can re-send unpublished rows.
- **Reconciliation**: Compare ledger commit counts vs R2 row counts per (project, customer, date) to detect drift.
- **Customer-facing audit API** (future): Query the ledger DO directly for recent events (sub-ms, no R2 round-trip). Query R2 Iceberg for historical.
- **Conflict alerting**: Same idempotency key with different payload hash indicates a client bug. Surface as a warning metric.
- **Billing verification**: At invoice time, compare Tinybird meter facts against ledger row counts.

## Schema

### Ledger DO SQLite table (9 columns)

```sql
CREATE TABLE IF NOT EXISTS ingestion_ledger (
  idempotency_key   TEXT PRIMARY KEY,
  canonical_audit_id TEXT NOT NULL UNIQUE,
  payload_hash       TEXT NOT NULL,
  status             TEXT NOT NULL,          -- "processed" | "rejected"
  rejection_reason   TEXT,
  result_json        TEXT,
  audit_payload_json TEXT NOT NULL,
  first_seen_at      INTEGER NOT NULL,
  published_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_unpublished
  ON ingestion_ledger (published_at) WHERE published_at IS NULL;
```

### Deterministic IDs

- **canonical_audit_id**: SHA-256 of `{projectId}\x1f{customerId}\x1f{idempotencyKey}` (Record Separator delimiter, not user-reproducible).
- **payload_hash**: SHA-256 of stable business fields only: `projectId`, `customerId`, `idempotencyKey`, `eventSlug`, `timestamp`, `properties`, optional client event id. Excludes `requestId`, `receivedAt`, `handledAt`.

### Lakehouse schema v2

Add two fields to the existing events source in the registry (both `required: false`, `addedInVersion: 2`):
- `canonical_audit_id` (string)
- `payload_hash` (string)

No events_canonical materialized table in v1. Query-time dedup via `ROW_NUMBER() OVER (PARTITION BY canonical_audit_id ORDER BY received_at) = 1`.

## Flows

### Async (queue consumer)

```
1. partitionDuplicateQueuedMessages()          -- unchanged, in-memory
2. groupMessagesByCustomer()                    -- unchanged
3. Per group: prepareCustomerMessageGroup()     -- batch grants lookup, unchanged
4. Per message: handleMessage()                 -- EntitlementWindowDO.apply(), no outer DO calls
5. After group: bucket outcomes by ledger shard
6. Per touched shard: ledgerStub.commit(entries) -- batched, non-blocking for ack
7. Ack all messages whose processing completed
```

DO calls go from **2N** (begin + complete per message) to **S** (one commit per touched shard, S <= 32, usually much less).

Ack/retry decision is based on the EntitlementWindowDO result, not the ledger commit. If `commit()` fails, messages are still acked (usage is durable), and a metric is emitted.

### Sync (ingestFeatureSync)

```
1. EntitlementWindowDO.apply(enforceLimit: true)  -- unchanged
2. Build response
3. waitUntil(ledgerStub.commit([entry]))           -- fire-and-forget, zero added latency
4. Return HTTP response immediately
```

`waitUntil` is already available via `ExecutionContext` and propagated through `ServiceDeps`. The sync path currently blocks on `publishOutcome()` — this removes that blocking call entirely.

### Ledger DO alarm

1. **Outbox flush**: `SELECT * FROM ingestion_ledger WHERE published_at IS NULL ORDER BY first_seen_at LIMIT 500`. Publish to `PIPELINE_EVENTS`. On success, `UPDATE published_at = now()`. On failure, reschedule alarm in 30s.
2. **Retention cleanup**: `DELETE FROM ingestion_ledger WHERE published_at IS NOT NULL AND first_seen_at < (now - 30 days) LIMIT 5000`.
3. **Stuck row detection**: If any row has `published_at IS NULL AND first_seen_at < (now - 10 minutes)`, emit an alert metric.

### commit() semantics

```
INSERT INTO ingestion_ledger (...) VALUES (...)
ON CONFLICT(idempotency_key) DO NOTHING
```

- Same key + same hash: silent dedup (normal retry).
- Same key + different hash: keep original row, emit `ledger_payload_conflict` metric. First-write-wins.
- New key: insert, schedule alarm if not already scheduled.
- Returns `{ inserted: number, duplicates: number, conflicts: number }`.

## Implementation steps

### Step 1: Lakehouse schema v2

**Files:**
- `internal/lakehouse/src/registry.ts` — add `canonical_audit_id` and `payload_hash` fields with `addedInVersion: 2`
- `apps/api/scripts/schemas/events.json` — regenerate via schema evolution script
- Follow `internal/lakehouse/SCHEMA_EVOLUTION.md` for pipeline resource updates

### Step 2: IngestionLedgerDO

**New file:** `apps/api/src/ingestion/IngestionLedgerDO.ts`

- Same DurableObject pattern as `IngestionIdempotencyDO.ts` (use as template)
- `blockConcurrencyWhile`: create table + indexes
- `commit(entries[])`: single transaction, INSERT ON CONFLICT DO NOTHING, schedule alarm
- `alarm()`: outbox flush to `PIPELINE_EVENTS` + retention cleanup (mirror EntitlementWindowDO alarm pattern from `EntitlementWindowDO.ts:294-374`)
- Receives `PIPELINE_EVENTS` binding via env (already available to DOs in wrangler.jsonc)

### Step 3: Ledger client + helpers

**New file:** `apps/api/src/ingestion/ledger-client.ts`

- `CloudflareLedgerClient` implements new `IngestionLedgerClient` interface
- Reuses `selectIdempotencyShardIndex()` from `apps/api/src/ingestion/idempotency.ts`
- New shard name: `"ledger:{appEnv}:{projectId}:{customerId}:{shardIndex}"`

**New file:** `internal/services/src/ingestion/ledger.ts`

- `IngestionLedgerClient` interface (replaces `IdempotencyClient`)
- `IngestionLedgerEntry` type, `IngestionLedgerCommitResult` type
- `computeCanonicalAuditId(projectId, customerId, idempotencyKey): string`
- `computePayloadHash(message): string`
- Both use `crypto.subtle.digest('SHA-256', ...)` (available in Workers)

### Step 4: Refactor ingestion service

**File:** `internal/services/src/ingestion/service.ts`

- Replace `IdempotencyClient` with `IngestionLedgerClient`
- Add `waitUntil` to constructor deps
- Rewrite `processCustomerGroup()`:
  - Remove per-message `processMessage()` with begin/complete/abort
  - Process all messages, collect outcomes + build ledger entries
  - After group: bucket entries by shard, call `commit()` per shard
  - Ack based on processing result, not commit result
- Rewrite `ingestFeatureSync()`:
  - Replace blocking `publishOutcome()` with `waitUntil(ledgerStub.commit(...))`
- Remove `publishPipelineEvent()`, `publishOutcome()`, `rejectMessage()` pipeline publish calls
- Keep `rejectMessage()` for building the outcome, just remove the inline publish
- Remove `abortClaim()` entirely

### Step 5: Wire bindings

**Files:**
- `apps/api/wrangler.jsonc` — add `IngestionLedgerDO` to `durable_objects.bindings` (all envs), add migration tag `new_sqlite_classes: ["IngestionLedgerDO"]`
- `apps/api/src/env.ts` — add `ingestionledger` binding type
- `apps/api/src/ingestion/service.ts` (the factory) — construct `CloudflareLedgerClient`, pass `waitUntil`
- `apps/api/src/ingestion/queue.ts` — pass `IngestionLedgerClient` instead of `IdempotencyClient`

### Step 6: Update tests

**Files:**
- `internal/services/src/ingestion/service.test.ts` — replace begin/complete/abort assertions with commit assertions
- `internal/services/src/ingestion/testing/serviceTestHarness.ts` — replace mock stubs

**New test cases:**
- Same-batch duplicate: dropped before processing (unchanged)
- Cross-batch retry: usage not double-counted, only one ledger row
- Retry after EntitlementWindowDO applied but before ledger commit: usage correct, ledger row inserted on retry
- Retry after ledger commit: commit is a no-op (ON CONFLICT DO NOTHING)
- Same key + different payload hash: original row kept, conflict metric emitted
- Hot customer batch: one commit() per touched shard, not per event
- Sync path: response returned before commit completes
- Alarm: publishes unpublished rows, sets published_at, retries on failure
- Alarm retention: deletes only published rows older than 30 days

## Migration

**Deploy together (one release):**
- IngestionLedgerDO deployed as new DO class
- IngestionIdempotencyDO kept in wrangler.jsonc but receives no traffic
- Service uses IngestionLedgerClient exclusively

**Cleanup release (30+ days later):**
- Remove IngestionIdempotencyDO class, binding, and migration tag
- Remove CloudflareIdempotencyClient, IdempotencyClient interface
- Existing idempotency rows expire naturally (30-day retention)

**Monitoring for rollout:**
- `ledger_commit_inserted` / `ledger_commit_duplicates` / `ledger_commit_conflicts` counters
- `ledger_commit_failed` counter (alert threshold)
- `ledger_unpublished_row_age_max` per shard (alert if > 5 min)
- `ledger_alarm_publish_batch_size` histogram

## Verification

1. Deploy to dev environment
2. Send duplicate events via async ingestion API — verify only one ledger row exists, EntitlementWindowDO usage counted once
3. Send same idempotency key with different properties — verify original row kept, conflict metric emitted
4. Kill worker mid-batch — verify retry produces correct state (no double-count, ledger row eventually committed)
5. Check R2 Data Catalog — verify events appear with `canonical_audit_id` and `payload_hash` fields populated
6. Send sync ingestion request — verify response latency is not increased vs baseline
7. Query R2 events with `ROW_NUMBER() OVER (PARTITION BY canonical_audit_id)` — verify dedup works
8. Run existing test suite: `pnpm test --filter=@unprice/services`
