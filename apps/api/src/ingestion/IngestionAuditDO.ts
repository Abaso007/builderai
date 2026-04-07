import type { Pipeline } from "cloudflare:pipelines"
import { DurableObject } from "cloudflare:workers"
import { parseLakehouseEvent } from "@unprice/lakehouse"
import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import { MAX_EVENT_AGE_MS } from "@unprice/services/entitlements"
import { apiDrain } from "~/observability"

const TABLE_NAME = "ingestion_audit"

const AUDIT_RETENTION_MS = MAX_EVENT_AGE_MS + 7 * 24 * 60 * 60 * 1000 // 7 days after the event
const OUTBOX_BATCH_SIZE = 500 // 500 rows
const RETENTION_CLEANUP_BATCH_SIZE = 5000 // 5000 rows
const ALARM_RETRY_DELAY_MS = 30_000 // 30 seconds
const STUCK_ROW_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

type LedgerEntry = {
  auditPayloadJson: string
  canonicalAuditId: string
  firstSeenAt: number
  idempotencyKey: string
  payloadHash: string
  rejectionReason?: string
  resultJson: string
  status: "processed" | "rejected"
}

type CommitResult = {
  conflicts: number
  duplicates: number
  inserted: number
}

type UnpublishedRow = {
  audit_payload_json: string
  canonical_audit_id: string
  first_seen_at: number
  idempotency_key: string
}

export class IngestionAuditDO extends DurableObject {
  private readonly ready: Promise<void>
  private readonly pipelineEvents: Pipeline
  private readonly logger: AppLogger

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.pipelineEvents = env.PIPELINE_EVENTS!

    const requestId = this.ctx.id.toString()
    const { logger } = createStandaloneRequestLogger({ requestId }, { flush: apiDrain?.flush })

    this.logger = logger
    this.logger.set({
      requestId,
      service: "ingestionaudit",
      request: { id: requestId },
      cloud: {
        platform: "cloudflare",
        durable_object_id: requestId,
      },
    })

    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          idempotency_key    TEXT PRIMARY KEY,
          canonical_audit_id TEXT NOT NULL UNIQUE,
          payload_hash       TEXT NOT NULL,
          status             TEXT NOT NULL,
          rejection_reason   TEXT,
          result_json        TEXT,
          audit_payload_json TEXT NOT NULL,
          first_seen_at      INTEGER NOT NULL,
          published_at       INTEGER
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_unpublished
        ON ${TABLE_NAME} (first_seen_at) WHERE published_at IS NULL
      `)
    })
  }

  public async commit(entries: LedgerEntry[]): Promise<CommitResult> {
    await this.ready

    if (entries.length === 0) {
      return { inserted: 0, duplicates: 0, conflicts: 0 }
    }

    let inserted = 0
    let duplicates = 0
    let conflicts = 0

    for (const entry of entries) {
      const existing = this.ctx.storage.sql
        .exec<{ payload_hash: string }>(
          `SELECT payload_hash FROM ${TABLE_NAME} WHERE idempotency_key = ?`,
          entry.idempotencyKey
        )
        .toArray()[0]

      if (existing) {
        if (existing.payload_hash === entry.payloadHash) {
          duplicates++
        } else {
          conflicts++
        }
        continue
      }

      this.ctx.storage.sql.exec(
        `
          INSERT INTO ${TABLE_NAME}
            (idempotency_key, canonical_audit_id, payload_hash, status,
             rejection_reason, result_json, audit_payload_json, first_seen_at, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(idempotency_key) DO NOTHING
        `,
        entry.idempotencyKey,
        entry.canonicalAuditId,
        entry.payloadHash,
        entry.status,
        entry.rejectionReason ?? null,
        entry.resultJson,
        entry.auditPayloadJson,
        entry.firstSeenAt
      )

      inserted++
    }

    if (inserted > 0) {
      await this.ensureAlarm()
    }

    return { inserted, duplicates, conflicts }
  }

  async alarm(): Promise<void> {
    await this.ready

    const published = await this.publishUnpublishedRows()
    this.cleanupExpiredRows()
    this.checkStuckRows()

    const hasUnpublished = this.ctx.storage.sql
      .exec<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${TABLE_NAME} WHERE published_at IS NULL`)
      .toArray()[0]

    if (hasUnpublished && hasUnpublished.cnt > 0) {
      if (published) {
        await this.ensureAlarm()
      } else {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_DELAY_MS)
      }
    }
  }

  private async publishUnpublishedRows(): Promise<boolean> {
    const rows = this.ctx.storage.sql
      .exec<UnpublishedRow>(
        `
          SELECT idempotency_key, canonical_audit_id, audit_payload_json, first_seen_at
          FROM ${TABLE_NAME}
          WHERE published_at IS NULL
          ORDER BY first_seen_at ASC
          LIMIT ?
        `,
        OUTBOX_BATCH_SIZE
      )
      .toArray()

    if (rows.length === 0) {
      return true
    }

    try {
      const events = rows.map((row) => {
        const payload = JSON.parse(row.audit_payload_json)
        return parseLakehouseEvent("events", payload)
      })

      await this.pipelineEvents.send(events)

      const now = Date.now()
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          `UPDATE ${TABLE_NAME} SET published_at = ? WHERE idempotency_key = ?`,
          now,
          row.idempotency_key
        )
      }

      return true
    } catch {
      return false
    }
  }

  private cleanupExpiredRows(): void {
    const cutoff = Date.now() - AUDIT_RETENTION_MS

    this.ctx.storage.sql.exec(
      `
        DELETE FROM ${TABLE_NAME}
        WHERE published_at IS NOT NULL
          AND first_seen_at < ?
        LIMIT ?
      `,
      cutoff,
      RETENTION_CLEANUP_BATCH_SIZE
    )
  }

  private checkStuckRows(): void {
    const threshold = Date.now() - STUCK_ROW_THRESHOLD_MS

    const stuck = this.ctx.storage.sql
      .exec<{ cnt: number }>(
        `
          SELECT COUNT(*) as cnt FROM ${TABLE_NAME}
          WHERE published_at IS NULL AND first_seen_at < ?
        `,
        threshold
      )
      .toArray()[0]

    if (stuck && stuck.cnt > 0) {
      this.logger.warn("audit rows unpublished for > 10 minutes", {
        count: stuck.cnt,
      })
    }
  }

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000)
    }
  }
}
