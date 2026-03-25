import type { Fact, MeterConfig, RawEvent, StorageAdapter, SyncStorageAdapter } from "./domain"
import { deriveMeterKey, validateEventTimestamp } from "./domain"

interface MeterStateSnapshot {
  value: number
  updatedAt: number
}

interface PendingUpdate {
  fact: Fact
  nextState: MeterStateSnapshot
}

type ApplyEventOptions = {
  beforePersist?: (facts: Fact[]) => void | Promise<void>
}

type ApplyEventSyncOptions = {
  beforePersist?: (facts: Fact[]) => void
}

const METER_STATE_PREFIX = "meter-state:"
const METER_STATE_UPDATED_AT_PREFIX = "meter-state-updated-at:"

export class AsyncMeterAggregationEngine {
  constructor(
    // we purposfully support an array of meters for being future proof
    // later one feature can support multiple meters
    private readonly meterConfigs: MeterConfig[],
    private readonly storage: StorageAdapter,
    private readonly now: number
  ) {
    this.now = now
  }

  async applyEvent(event: RawEvent, options?: ApplyEventOptions): Promise<Fact[]> {
    // validate now again with a global now to avoid clock skews
    validateEventTimestamp(event.timestamp, this.now)

    const applicableMeters = this.meterConfigs.filter(
      (meterConfig) => meterConfig.eventSlug === event.slug
    )

    if (applicableMeters.length === 0) {
      return []
    }

    const pendingUpdates = await Promise.all(
      applicableMeters.map(async (meterConfig) => {
        const meterKey = deriveMeterKey(meterConfig)
        const currentState = await this.readCurrentState(meterKey)
        return this.computePendingUpdate(meterConfig, meterKey, event, currentState)
      })
    )

    const facts = pendingUpdates.map(({ fact }) => fact)

    if (options?.beforePersist) {
      await options.beforePersist(facts)
    }

    await Promise.all(
      pendingUpdates.map(async ({ fact, nextState }) => {
        await this.writeCurrentState(fact.meterKey, nextState)
      })
    )

    return facts
  }

  applyEventSync(event: RawEvent, options?: ApplyEventSyncOptions): Fact[] {
    validateEventTimestamp(event.timestamp, Date.now())

    const applicableMeters = this.meterConfigs.filter(
      (meterConfig) => meterConfig.eventSlug === event.slug
    )

    if (applicableMeters.length === 0) {
      return []
    }

    const pendingUpdates = applicableMeters.map((meterConfig) => {
      const meterKey = deriveMeterKey(meterConfig)
      const currentState = this.readCurrentStateSync(meterKey)
      return this.computePendingUpdate(meterConfig, meterKey, event, currentState)
    })

    const facts = pendingUpdates.map(({ fact }) => fact)

    if (options?.beforePersist) {
      options.beforePersist(facts)
    }

    for (const { fact, nextState } of pendingUpdates) {
      this.writeCurrentStateSync(fact.meterKey, nextState)
    }

    return facts
  }

  private async readCurrentState(meterKey: string): Promise<MeterStateSnapshot | null> {
    const [value, updatedAt] = await Promise.all([
      this.storage.get<number>(this.makeStateKey(meterKey)),
      this.storage.get<number>(this.makeUpdatedAtKey(meterKey)),
    ])

    return this.toMeterStateSnapshot(value, updatedAt)
  }

  private readCurrentStateSync(meterKey: string): MeterStateSnapshot | null {
    const syncStorage = this.getSyncStorage()
    const value = syncStorage.getSync<number>(this.makeStateKey(meterKey))
    const updatedAt = syncStorage.getSync<number>(this.makeUpdatedAtKey(meterKey))

    return this.toMeterStateSnapshot(value, updatedAt)
  }

  private async writeCurrentState(meterKey: string, state: MeterStateSnapshot): Promise<void> {
    await Promise.all([
      this.storage.put(this.makeStateKey(meterKey), state.value),
      this.storage.put(this.makeUpdatedAtKey(meterKey), state.updatedAt),
    ])
  }

  private writeCurrentStateSync(meterKey: string, state: MeterStateSnapshot): void {
    const syncStorage = this.getSyncStorage()
    syncStorage.putSync(this.makeStateKey(meterKey), state.value)
    syncStorage.putSync(this.makeUpdatedAtKey(meterKey), state.updatedAt)
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
    meterConfig: MeterConfig,
    meterKey: string,
    event: RawEvent,
    currentState: MeterStateSnapshot | null
  ): PendingUpdate {
    const previousValue = currentState?.value ?? 0
    const previousUpdatedAt = currentState?.updatedAt ?? Number.NEGATIVE_INFINITY

    switch (meterConfig.aggregationMethod) {
      case "count": {
        const nextValue = previousValue + 1

        return {
          fact: {
            eventId: event.id,
            meterKey,
            delta: 1,
            valueAfter: nextValue,
          },
          nextState: {
            value: nextValue,
            updatedAt: Math.max(previousUpdatedAt, event.timestamp),
          },
        }
      }

      case "sum": {
        const numericValue = this.readNumericFieldValue(meterConfig, event)

        const nextValue = previousValue + numericValue

        return {
          fact: {
            eventId: event.id,
            meterKey,
            delta: numericValue,
            valueAfter: nextValue,
          },
          nextState: {
            value: nextValue,
            updatedAt: Math.max(previousUpdatedAt, event.timestamp),
          },
        }
      }

      case "max": {
        const numericValue = this.readNumericFieldValue(meterConfig, event)

        const nextValue =
          currentState === null ? numericValue : Math.max(previousValue, numericValue)

        return {
          fact: {
            eventId: event.id,
            meterKey,
            delta: nextValue - previousValue,
            valueAfter: nextValue,
          },
          nextState: {
            value: nextValue,
            updatedAt: Math.max(previousUpdatedAt, event.timestamp),
          },
        }
      }

      case "latest": {
        const numericValue = this.readNumericFieldValue(meterConfig, event)

        if (event.timestamp < previousUpdatedAt) {
          return {
            fact: {
              eventId: event.id,
              meterKey,
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
            meterKey,
            delta: numericValue - previousValue,
            valueAfter: numericValue,
          },
          nextState: {
            value: numericValue,
            updatedAt: event.timestamp,
          },
        }
      }

      default:
        return this.assertUnsupportedAggregationMethod(meterConfig.aggregationMethod)
    }
  }

  private readNumericFieldValue(meterConfig: MeterConfig, event: RawEvent): number {
    const field = meterConfig.aggregationField

    if (!field) {
      throw new Error(`Meter ${meterConfig.eventId} requires an aggregation field`)
    }

    const rawValue = event.properties[field]

    const numericValue = parseFiniteNumericValue(rawValue)

    if (numericValue === null) {
      throw new Error(
        `Meter ${meterConfig.eventId} requires a finite numeric value at properties.${field}`
      )
    }

    return numericValue
  }

  private assertUnsupportedAggregationMethod(_aggregationMethod: never): never {
    throw new Error("Unsupported aggregation method")
  }

  private makeStateKey(meterKey: string): string {
    return `${METER_STATE_PREFIX}${meterKey}`
  }

  private makeUpdatedAtKey(meterKey: string): string {
    return `${METER_STATE_UPDATED_AT_PREFIX}${meterKey}`
  }
}

function parseFiniteNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== "string") {
    return null
  }

  const trimmedValue = value.trim()

  if (trimmedValue.length === 0) {
    return null
  }

  const parsedValue = Number(trimmedValue)

  return Number.isFinite(parsedValue) ? parsedValue : null
}
