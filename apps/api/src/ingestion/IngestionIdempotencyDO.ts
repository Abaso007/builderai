import { DurableObject } from "cloudflare:workers"
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_RETENTION_MS } from "./idempotency"

const TABLE_NAME = "ingestion_idempotency"

type IdempotencyStatus = "completed" | "processing"

type BeginInput = {
  idempotencyKey: string
  now: number
}

type CompleteInput = {
  idempotencyKey: string
  now: number
  result?: string
}

type AbortInput = {
  idempotencyKey: string
}

type BeginResult = {
  completedResult?: string
  decision: "busy" | "duplicate" | "process"
  retryAfterSeconds?: number
}

type IdempotencyRow = {
  expires_at: number
  lease_until: number
  result: string | null
  status: IdempotencyStatus
}

export class IngestionIdempotencyDO extends DurableObject {
  private readonly ready: Promise<void>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)

    // simple table, we migrate on startup
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          idempotency_key TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          lease_until INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          result TEXT
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_expires_at
        ON ${TABLE_NAME} (expires_at)
      `)
    })
  }

  public async begin(input: BeginInput): Promise<BeginResult> {
    await this.ready
    this.assertValidInput(input.idempotencyKey, input.now)

    const existing = this.getRow(input.idempotencyKey)
    const leaseUntil = input.now + IDEMPOTENCY_LEASE_MS
    const expiresAt = input.now + IDEMPOTENCY_RETENTION_MS

    if (!existing) {
      this.ctx.storage.sql.exec(
        `
          INSERT INTO ${TABLE_NAME} (idempotency_key, status, lease_until, expires_at, result)
          VALUES (?, 'processing', ?, ?, NULL)
        `,
        input.idempotencyKey,
        leaseUntil,
        expiresAt
      )
      await this.scheduleAlarm(expiresAt)
      return { decision: "process" }
    }

    if (existing.status === "completed" && existing.expires_at > input.now) {
      return {
        decision: "duplicate",
        completedResult: existing.result ?? undefined,
      }
    }

    if (existing.status === "processing" && existing.lease_until > input.now) {
      return {
        decision: "busy",
        retryAfterSeconds: Math.max(1, Math.ceil((existing.lease_until - input.now) / 1000)),
      }
    }

    // set as processing
    this.ctx.storage.sql.exec(
      `
        UPDATE ${TABLE_NAME}
        SET status = 'processing', lease_until = ?, expires_at = ?, result = NULL
        WHERE idempotency_key = ?
      `,
      leaseUntil,
      expiresAt,
      input.idempotencyKey
    )

    // schedule alarm to handle deletion
    await this.scheduleAlarm(expiresAt)

    return { decision: "process" }
  }

  public async complete(input: CompleteInput): Promise<void> {
    await this.ready
    this.assertValidInput(input.idempotencyKey, input.now)

    const expiresAt = input.now + IDEMPOTENCY_RETENTION_MS

    this.ctx.storage.sql.exec(
      `
        INSERT INTO ${TABLE_NAME} (idempotency_key, status, lease_until, expires_at, result)
        VALUES (?, 'completed', 0, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE
        SET status = 'completed',
            lease_until = 0,
            expires_at = excluded.expires_at,
            result = excluded.result
      `,
      input.idempotencyKey,
      expiresAt,
      input.result ?? null
    )

    await this.scheduleAlarm(expiresAt)
  }

  public async abort(input: AbortInput): Promise<void> {
    await this.ready

    if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") {
      throw new TypeError("Invalid idempotency key")
    }

    this.ctx.storage.sql.exec(
      `
        DELETE FROM ${TABLE_NAME}
        WHERE idempotency_key = ?
          AND status = 'processing'
      `,
      input.idempotencyKey
    )
  }

  async alarm(): Promise<void> {
    await this.ready

    // delete expired keys
    this.ctx.storage.sql.exec(`DELETE FROM ${TABLE_NAME} WHERE expires_at <= ?`, Date.now())

    const next = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        `SELECT expires_at FROM ${TABLE_NAME} ORDER BY expires_at ASC LIMIT 1`
      )
      .toArray()[0]

    // if there are no more, delete the alarm, otherwise set the next alarm to the expired date
    if (!next) {
      await this.ctx.storage.deleteAlarm()
      return
    }

    await this.scheduleAlarm(next.expires_at)
  }

  private getRow(idempotencyKey: string): IdempotencyRow | null {
    return (
      this.ctx.storage.sql
        .exec<IdempotencyRow>(
          `
            SELECT status, lease_until, expires_at, result
            FROM ${TABLE_NAME}
            WHERE idempotency_key = ?
          `,
          idempotencyKey
        )
        .toArray()[0] ?? null
    )
  }

  private async scheduleAlarm(at: number): Promise<void> {
    const nextAlarmAt = Math.max(Date.now() + 1, at)
    const currentAlarm = await this.ctx.storage.getAlarm()

    if (currentAlarm === null || nextAlarmAt < currentAlarm) {
      await this.ctx.storage.setAlarm(nextAlarmAt)
    }
  }

  private assertValidInput(idempotencyKey: string, now: number): void {
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new TypeError("Invalid idempotency key")
    }

    if (!Number.isFinite(now)) {
      throw new TypeError("Invalid timestamp")
    }
  }
}
