import { DurableObject } from "cloudflare:workers"
import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  LimitExceededError,
  type MeterDefinition,
  type RawEvent,
} from "@unprice/services/entitlements"
import { eq } from "drizzle-orm"
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

    try {
      return this.db.transaction((tx) => {
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
}
