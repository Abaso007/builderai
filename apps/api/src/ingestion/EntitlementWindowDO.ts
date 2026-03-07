import { DurableObject } from "cloudflare:workers"
import type { OverageStrategy } from "@unprice/db/validators"
import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type MeterConfig,
  type RawEvent,
} from "@unprice/services/entitlements"
import { asc, eq, inArray, lt, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { idempotencyKeysTable, meterFactsOutboxTable } from "./db/schema"
import { schema } from "./db/schema"
import { DrizzleStorageAdapter } from "./drizzle-adapter"
import migrations from "./drizzle/migrations"
import { findLimitExceededFact } from "./limit-policy"

const VALID_OVERAGE_STRATEGIES = new Set<OverageStrategy>(["none", "last-call", "always"])

class EntitlementWindowLimitExceededError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterId: string
      limit: number
      valueAfter: number
    }
  ) {
    super(`Limit exceeded for meter ${params.meterId}`)
    this.name = EntitlementWindowLimitExceededError.name
  }
}

type ApplyInput = {
  event: RawEvent
  meters: MeterConfig[]
  limit?: number | null
  overageStrategy?: OverageStrategy
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

    // 1. validate the input
    this.assertValidInput(input)

    // 2. check if the event is already processed
    let insertedFactCount = 0

    try {
      // fan out pattern to avoid losing events if the transaction fails
      const result = this.db.transaction((tx) => {
        const existing = tx
          .select({ result: idempotencyKeysTable.result })
          .from(idempotencyKeysTable)
          .where(eq(idempotencyKeysTable.eventId, input.event.id))
          .get()

        if (existing?.result) {
          return this.parseStoredResult(existing.result)
        }

        // create the adapter and the engine
        const adapter = new DrizzleStorageAdapter(tx)
        // create the engine
        const engine = new AsyncMeterAggregationEngine(input.meters, adapter)
        // apply the event
        const facts = engine.applyEventSync(input.event, {
          beforePersist: (pendingFacts) => {
            const exceeded = findLimitExceededFact({
              facts: pendingFacts,
              limit: input.limit,
              overageStrategy: input.overageStrategy,
            })

            if (exceeded && typeof input.limit === "number" && Number.isFinite(input.limit)) {
              throw new EntitlementWindowLimitExceededError({
                eventId: input.event.id,
                meterId: exceeded.meterId,
                limit: input.limit,
                valueAfter: exceeded.valueAfter,
              })
            }
          },
        })

        insertedFactCount = facts.length

        // create the outbox batch of facts
        for (const fact of facts) {
          tx.insert(meterFactsOutboxTable)
            .values({ payload: JSON.stringify(fact) })
            .run()
        }

        // create the idempotency key
        const successResult: ApplyResult = { allowed: true }

        // store the result
        tx.insert(idempotencyKeysTable)
          .values({
            eventId: input.event.id,
            createdAt: Date.now(),
            result: JSON.stringify(successResult),
          })
          .run()

        // return the result
        return successResult
      })

      if (result.allowed && insertedFactCount > 0) {
        // set the alarm to flush the outbox to tinybird
        const currentAlarm = await this.ctx.storage.getAlarm()
        if (currentAlarm === null) {
          await this.ctx.storage.setAlarm(Date.now() + 30_000)
        }
      }

      return result
    } catch (error) {
      if (error instanceof EntitlementWindowLimitExceededError) {
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
      // this needs to be reliable and idempotent
      const flushed = await this.flushToTinybird(batch)
      if (flushed) {
        // delete the outbox records with cursor based deletion
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

    // we need to keep to idempotency keys for the same period as late arrival of events meaning 30 days
    this.db
      .delete(idempotencyKeysTable)
      .where(lt(idempotencyKeysTable.createdAt, Date.now() - 30 * 24 * 60 * 60 * 1000)) // 30 days
      .run()

    const remainingOutboxCount = this.getOutboxCount()
    // after the entitlement end we give 30 days to self destruct
    const selfDestructAt = this.getPeriodEndMs() + 30 * 24 * 60 * 60 * 1000 // 30 days

    // delete the DO if the period is over and there are no remaining outbox records
    if (Date.now() > selfDestructAt && remainingOutboxCount === 0) {
      await this.ctx.storage.deleteAlarm()
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
    const hasValidLimit =
      input.limit === undefined ||
      input.limit === null ||
      (typeof input.limit === "number" && Number.isFinite(input.limit))

    const hasValidOverageStrategy =
      input.overageStrategy === undefined || VALID_OVERAGE_STRATEGIES.has(input.overageStrategy)

    if (
      !input ||
      !input.event ||
      !Array.isArray(input.meters) ||
      !hasValidLimit ||
      !hasValidOverageStrategy
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
    const row = this.db.select({ count: sql<number>`count(*)` }).from(meterFactsOutboxTable).get()

    return Number(row?.count ?? 0)
  }
}
