import type { Fact, MeterDefinition, RawEvent, StorageAdapter, SyncStorageAdapter } from "./domain"
import { LimitExceededError, validateEventTimestamp } from "./domain"

interface MeterStateSnapshot {
  value: number
  updatedAt: number
}

interface PendingUpdate {
  fact: Fact
  nextState: MeterStateSnapshot
}

const METER_STATE_PREFIX = "meter-state:"
const METER_STATE_UPDATED_AT_PREFIX = "meter-state-updated-at:"

export class AsyncMeterAggregationEngine {
  constructor(
    private readonly meterDefinitions: MeterDefinition[],
    private readonly storage: StorageAdapter
  ) {}

  async applyEvent(event: RawEvent, limit?: number): Promise<Fact[]> {
    validateEventTimestamp(event.timestamp, Date.now())

    const applicableMeters = this.meterDefinitions.filter(
      (meterDefinition) => meterDefinition.eventType === event.type
    )

    if (applicableMeters.length === 0) {
      return []
    }

    const pendingUpdates = await Promise.all(
      applicableMeters.map(async (meterDefinition) => {
        const currentState = await this.readCurrentState(meterDefinition.id)
        return this.computePendingUpdate(meterDefinition, event, currentState)
      })
    )

    const appliedUpdates = this.toAppliedUpdates(pendingUpdates)
    this.assertLimit(event.id, appliedUpdates, limit)

    await Promise.all(
      appliedUpdates.map(async ({ fact, nextState }) => {
        await this.writeCurrentState(fact.meterId, nextState)
      })
    )

    return appliedUpdates.map(({ fact }) => fact)
  }

  applyEventSync(event: RawEvent, limit?: number): Fact[] {
    validateEventTimestamp(event.timestamp, Date.now())

    const applicableMeters = this.meterDefinitions.filter(
      (meterDefinition) => meterDefinition.eventType === event.type
    )

    if (applicableMeters.length === 0) {
      return []
    }

    const pendingUpdates = applicableMeters.map((meterDefinition) => {
      const currentState = this.readCurrentStateSync(meterDefinition.id)
      return this.computePendingUpdate(meterDefinition, event, currentState)
    })

    const appliedUpdates = this.toAppliedUpdates(pendingUpdates)
    this.assertLimit(event.id, appliedUpdates, limit)

    for (const { fact, nextState } of appliedUpdates) {
      this.writeCurrentStateSync(fact.meterId, nextState)
    }

    return appliedUpdates.map(({ fact }) => fact)
  }

  private async readCurrentState(meterId: string): Promise<MeterStateSnapshot | null> {
    const [value, updatedAt] = await Promise.all([
      this.storage.get<number>(this.makeStateKey(meterId)),
      this.storage.get<number>(this.makeUpdatedAtKey(meterId)),
    ])

    return this.toMeterStateSnapshot(value, updatedAt)
  }

  private readCurrentStateSync(meterId: string): MeterStateSnapshot | null {
    const syncStorage = this.getSyncStorage()
    const value = syncStorage.getSync<number>(this.makeStateKey(meterId))
    const updatedAt = syncStorage.getSync<number>(this.makeUpdatedAtKey(meterId))

    return this.toMeterStateSnapshot(value, updatedAt)
  }

  private async writeCurrentState(meterId: string, state: MeterStateSnapshot): Promise<void> {
    await Promise.all([
      this.storage.put(this.makeStateKey(meterId), state.value),
      this.storage.put(this.makeUpdatedAtKey(meterId), state.updatedAt),
    ])
  }

  private writeCurrentStateSync(meterId: string, state: MeterStateSnapshot): void {
    const syncStorage = this.getSyncStorage()
    syncStorage.putSync(this.makeStateKey(meterId), state.value)
    syncStorage.putSync(this.makeUpdatedAtKey(meterId), state.updatedAt)
  }

  private toMeterStateSnapshot(
    value: number | null,
    updatedAt: number | null
  ): MeterStateSnapshot | null {
    if (value === null) {
      return null
    }

    return {
      value: Number(value),
      updatedAt: updatedAt === null ? Number.NEGATIVE_INFINITY : Number(updatedAt),
    }
  }

  private toAppliedUpdates(pendingUpdates: Array<PendingUpdate | null>): PendingUpdate[] {
    return pendingUpdates.filter(
      (pendingUpdate): pendingUpdate is PendingUpdate => pendingUpdate !== null
    )
  }

  private assertLimit(eventId: string, appliedUpdates: PendingUpdate[], limit?: number): void {
    if (limit === undefined || !Number.isFinite(limit)) {
      return
    }

    const exceeded = appliedUpdates.find(({ fact }) => fact.valueAfter > limit)
    if (!exceeded) {
      return
    }

    throw new LimitExceededError({
      eventId,
      meterId: exceeded.fact.meterId,
      limit,
      valueAfter: exceeded.fact.valueAfter,
    })
  }

  private getSyncStorage(): SyncStorageAdapter {
    const syncStorage = this.storage as Partial<SyncStorageAdapter>

    if (
      typeof syncStorage.getSync !== "function" ||
      typeof syncStorage.putSync !== "function" ||
      typeof syncStorage.listSync !== "function"
    ) {
      throw new Error("Storage adapter does not support synchronous meter aggregation")
    }

    return syncStorage as SyncStorageAdapter
  }

  private computePendingUpdate(
    meterDefinition: MeterDefinition,
    event: RawEvent,
    currentState: MeterStateSnapshot | null
  ): PendingUpdate | null {
    const previousValue = currentState?.value ?? 0
    const previousUpdatedAt = currentState?.updatedAt ?? Number.NEGATIVE_INFINITY

    if (meterDefinition.aggregation.type === "COUNT") {
      const nextValue = previousValue + 1

      return {
        fact: {
          eventId: event.id,
          meterId: meterDefinition.id,
          delta: 1,
          valueAfter: nextValue,
        },
        nextState: {
          value: nextValue,
          updatedAt: Math.max(previousUpdatedAt, event.timestamp),
        },
      }
    }

    const numericValue = this.readNumericFieldValue(meterDefinition, event)

    if (numericValue === null) {
      return null
    }

    if (meterDefinition.aggregation.type === "SUM") {
      const nextValue = previousValue + numericValue

      return {
        fact: {
          eventId: event.id,
          meterId: meterDefinition.id,
          delta: numericValue,
          valueAfter: nextValue,
        },
        nextState: {
          value: nextValue,
          updatedAt: Math.max(previousUpdatedAt, event.timestamp),
        },
      }
    }

    if (meterDefinition.aggregation.type === "MAX") {
      const nextValue = currentState === null ? numericValue : Math.max(previousValue, numericValue)

      return {
        fact: {
          eventId: event.id,
          meterId: meterDefinition.id,
          delta: nextValue - previousValue,
          valueAfter: nextValue,
        },
        nextState: {
          value: nextValue,
          updatedAt: Math.max(previousUpdatedAt, event.timestamp),
        },
      }
    }

    if (event.timestamp < previousUpdatedAt) {
      return {
        fact: {
          eventId: event.id,
          meterId: meterDefinition.id,
          delta: 0,
          valueAfter: previousValue,
        },
        nextState: currentState ?? {
          value: previousValue,
          updatedAt: previousUpdatedAt,
        },
      }
    }

    return {
      fact: {
        eventId: event.id,
        meterId: meterDefinition.id,
        delta: numericValue - previousValue,
        valueAfter: numericValue,
      },
      nextState: {
        value: numericValue,
        updatedAt: event.timestamp,
      },
    }
  }

  private readNumericFieldValue(meterDefinition: MeterDefinition, event: RawEvent): number | null {
    const field = meterDefinition.aggregation.field

    if (!field) {
      return this.handleMissingNumericValue(
        meterDefinition,
        `Meter ${meterDefinition.id} requires an aggregation field`
      )
    }

    const rawValue = event.properties[field]

    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      return this.handleMissingNumericValue(
        meterDefinition,
        `Meter ${meterDefinition.id} requires a finite numeric value at properties.${field}`
      )
    }

    return rawValue
  }

  private handleMissingNumericValue(
    meterDefinition: MeterDefinition,
    message: string
  ): number | null {
    if (meterDefinition.enforcementMode === "soft") {
      return null
    }

    throw new Error(message)
  }

  private makeStateKey(meterId: string): string {
    return `${METER_STATE_PREFIX}${meterId}`
  }

  private makeUpdatedAtKey(meterId: string): string {
    return `${METER_STATE_UPDATED_AT_PREFIX}${meterId}`
  }
}
