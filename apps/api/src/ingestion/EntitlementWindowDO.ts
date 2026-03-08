import { DurableObject } from "cloudflare:workers"
import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  LimitExceededError,
  type MeterDefinition,
  type RawEvent,
} from "@unprice/services/entitlements"
import { asc, eq, inArray, lt, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { DrizzleStorageAdapter } from "./drizzle-adapter"
import migrations from "./drizzle/migrations"
import { idempotencyKeysTable, meterFactsOutboxTable, schema } from "./schema"

type ApplyInput = {
  event: RawEvent
  meters: MeterDefinition[]
  limit: number
}

type ApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED"
  message?: string
}

type OutboxBatchRow = {
  id: number
  payload: string
}

export class EntitlementWindowDO extends DurableObject {
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly ready: Promise<void>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)

    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations)
    })
  }

  public async apply(input: ApplyInput): Promise<ApplyResult> {
    await this.ready

    this.assertValidInput(input)
    let insertedFactCount = 0

    try {
      const result = this.db.transaction((tx) => {
        const existing = tx
          .select({ result: idempotencyKeysTable.result })
          .from(idempotencyKeysTable)
          .where(eq(idempotencyKeysTable.eventId, input.event.id))
          .get()

        if (existing?.result) {
          return this.parseStoredResult(existing.result)
        }

        const adapter = new DrizzleStorageAdapter(tx)
        const engine = new AsyncMeterAggregationEngine(input.meters, adapter)
        const facts = engine.applyEventSync(input.event, input.limit)
        insertedFactCount = facts.length

        for (const fact of facts) {
          tx.insert(meterFactsOutboxTable)
            .values({ payload: JSON.stringify(fact) })
            .run()
        }

        const successResult: ApplyResult = { allowed: true }

        tx.insert(idempotencyKeysTable)
          .values({
            eventId: input.event.id,
            createdAt: Date.now(),
            result: JSON.stringify(successResult),
          })
          .run()

        return successResult
      })

      if (result.allowed && insertedFactCount > 0) {
        const currentAlarm = await this.ctx.storage.getAlarm()
        if (currentAlarm === null) {
          await this.ctx.storage.setAlarm(Date.now() + 30_000)
        }
      }

      return result
    } catch (error) {
      if (error instanceof LimitExceededError) {
        return {
          allowed: false,
          deniedReason: "LIMIT_EXCEEDED",
          message: error.message,
        }
      }

      if (
        error instanceof EventTimestampTooFarInFutureError ||
        error instanceof EventTimestampTooOldError
      ) {
        throw error
      }

      throw error
    }
  }

  async alarm(): Promise<void> {
    await this.ready

    const batch = this.db
      .select({
        id: meterFactsOutboxTable.id,
        payload: meterFactsOutboxTable.payload,
      })
      .from(meterFactsOutboxTable)
      .orderBy(asc(meterFactsOutboxTable.id))
      .limit(1000)
      .all()

    if (batch.length > 0) {
      const flushed = await this.flushToTinybird(batch)
      if (flushed) {
        this.db
          .delete(meterFactsOutboxTable)
          .where(
            inArray(
              meterFactsOutboxTable.id,
              batch.map((row) => row.id)
            )
          )
          .run()
      }
    }

    this.db
      .delete(idempotencyKeysTable)
      .where(lt(idempotencyKeysTable.createdAt, Date.now() - 24 * 60 * 60 * 1000))
      .run()

    const remainingOutboxCount = this.getOutboxCount()
    const selfDestructAt = this.getPeriodEndMs() + 30 * 24 * 60 * 60 * 1000

    if (Date.now() > selfDestructAt && remainingOutboxCount === 0) {
      await this.ctx.storage.deleteAll()
      return
    }

    if (remainingOutboxCount > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      return
    }

    await this.ctx.storage.setAlarm(selfDestructAt)
  }

  private assertValidInput(input: ApplyInput): void {
    if (
      !input ||
      !input.event ||
      !Array.isArray(input.meters) ||
      typeof input.limit !== "number" ||
      !Number.isFinite(input.limit)
    ) {
      throw new TypeError("Invalid apply payload")
    }
  }

  private parseStoredResult(result: string): ApplyResult {
    const parsed = JSON.parse(result) as Partial<ApplyResult>
    return {
      allowed: parsed.allowed === true,
      deniedReason: parsed.deniedReason,
      message: parsed.message,
    }
  }

  private async flushToTinybird(_batch: OutboxBatchRow[]): Promise<boolean> {
    return true
  }

  private getPeriodEndMs(): number {
    return Date.now() - 10 * 24 * 60 * 60 * 1000
  }

  private getOutboxCount(): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(meterFactsOutboxTable)
      .get()

    return Number(row?.count ?? 0)
  }
}
