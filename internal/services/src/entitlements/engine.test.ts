import { describe, expect, it } from "vitest"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type Fact,
  LimitExceededError,
  type MeterDefinition,
  PeriodKeyComputationError,
  type RawEvent,
  type StorageAdapter,
  computePeriodKey,
  validateEventTimestamp,
} from "./domain"
import { AsyncMeterAggregationEngine } from "./engine"

class InMemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value)
  }

  async list<T>(prefix: string): Promise<T[]> {
    return Array.from(this.store.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value as T)
  }
}

describe("validateEventTimestamp", () => {
  it("throws a future-specific error when the event is at least five seconds ahead", () => {
    const serverTimeMs = Date.UTC(2026, 2, 8, 10, 0, 0)

    expect(() => validateEventTimestamp(serverTimeMs + 5_000, serverTimeMs)).toThrow(
      EventTimestampTooFarInFutureError
    )
  })

  it("throws an old-event error when the event is older than thirty days", () => {
    const serverTimeMs = Date.UTC(2026, 2, 8, 10, 0, 0)
    const tooOldEventTimeMs = serverTimeMs - 30 * 24 * 60 * 60 * 1_000 - 1

    expect(() => validateEventTimestamp(tooOldEventTimeMs, serverTimeMs)).toThrow(
      EventTimestampTooOldError
    )
  })

  it("accepts timestamps inside the allowed window", () => {
    const serverTimeMs = Date.UTC(2026, 2, 8, 10, 0, 0)

    expect(() => validateEventTimestamp(serverTimeMs + 4_999, serverTimeMs)).not.toThrow()
    expect(() =>
      validateEventTimestamp(serverTimeMs - 30 * 24 * 60 * 60 * 1_000, serverTimeMs)
    ).not.toThrow()
  })
})

describe("computePeriodKey", () => {
  it("uses the shared cycle window and returns interval:start for onetime plans", () => {
    const effectiveStartDate = Date.UTC(2026, 0, 1)

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 2, 8),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "onetime",
          intervalCount: 1,
          anchor: "dayOfCreation",
          planType: "onetime",
        },
      })
    ).toBe(`onetime:${effectiveStartDate}`)
  })

  it("returns interval:start for recurring month plans using the shared cycle logic", () => {
    const effectiveStartDate = Date.UTC(2026, 0, 1, 0, 0, 0)
    const now = Date.UTC(2026, 1, 20, 0, 0, 0)

    expect(
      computePeriodKey({
        now,
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          anchor: 15,
          planType: "recurring",
        },
      })
    ).toBe(`month:${Date.UTC(2026, 1, 15, 0, 0, 0)}`)
  })

  it("throws when there is no active cycle for the requested timestamp", () => {
    expect(() =>
      computePeriodKey({
        now: Date.UTC(2025, 11, 31, 23, 59, 59),
        effectiveStartDate: Date.UTC(2026, 0, 1, 0, 0, 0),
        effectiveEndDate: null,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          anchor: 15,
          planType: "recurring",
        },
      })
    ).toThrow(PeriodKeyComputationError)
  })
})

describe("AsyncMeterAggregationEngine", () => {
  it("aggregates SUM, COUNT, MAX, and LATEST meters for matching events", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(createMeterDefinitions(), storage)
    const firstEvent = createPurchaseEvent({
      id: "evt_1",
      timestamp: Date.now() - 1_000,
      amount: 10,
    })
    const secondEvent = createPurchaseEvent({
      id: "evt_2",
      timestamp: Date.now(),
      amount: 4,
    })

    expect(await engine.applyEvent(firstEvent)).toEqual<Fact[]>([
      { eventId: "evt_1", meterId: "meter_sum", delta: 10, valueAfter: 10 },
      { eventId: "evt_1", meterId: "meter_count", delta: 1, valueAfter: 1 },
      { eventId: "evt_1", meterId: "meter_max", delta: 10, valueAfter: 10 },
      { eventId: "evt_1", meterId: "meter_latest", delta: 10, valueAfter: 10 },
    ])

    expect(await engine.applyEvent(secondEvent)).toEqual<Fact[]>([
      { eventId: "evt_2", meterId: "meter_sum", delta: 4, valueAfter: 14 },
      { eventId: "evt_2", meterId: "meter_count", delta: 1, valueAfter: 2 },
      { eventId: "evt_2", meterId: "meter_max", delta: 0, valueAfter: 10 },
      { eventId: "evt_2", meterId: "meter_latest", delta: -6, valueAfter: 4 },
    ])
  })

  it("skips soft meters when the numeric aggregation field is missing", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(
      [
        {
          id: "meter_soft_sum",
          eventType: "purchase",
          aggregation: { type: "SUM", field: "amount" },
          enforcementMode: "soft",
        },
      ],
      storage
    )

    const facts = await engine.applyEvent({
      id: "evt_missing_amount",
      type: "purchase",
      timestamp: Date.now(),
      properties: {},
    })

    expect(facts).toEqual([])
    expect(await storage.list<number>("meter-state:")).toEqual([])
  })

  it("throws for hard meters when the numeric aggregation field is missing", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(
      [
        {
          id: "meter_hard_sum",
          eventType: "purchase",
          aggregation: { type: "SUM", field: "amount" },
          enforcementMode: "hard",
        },
      ],
      storage
    )

    await expect(
      engine.applyEvent({
        id: "evt_missing_amount",
        type: "purchase",
        timestamp: Date.now(),
        properties: {},
      })
    ).rejects.toThrow("requires a finite numeric value")

    expect(await storage.list<number>("meter-state:")).toEqual([])
  })

  it("does not let a stale LATEST event overwrite a newer value", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(
      [
        {
          id: "meter_latest",
          eventType: "purchase",
          aggregation: { type: "LATEST", field: "amount" },
          enforcementMode: "hard",
        },
      ],
      storage
    )

    const now = Date.now()

    await engine.applyEvent(
      createPurchaseEvent({
        id: "evt_new",
        timestamp: now,
        amount: 10,
      })
    )

    const facts = await engine.applyEvent(
      createPurchaseEvent({
        id: "evt_old",
        timestamp: now - 1_000,
        amount: 99,
      })
    )

    expect(facts).toEqual([
      { eventId: "evt_old", meterId: "meter_latest", delta: 0, valueAfter: 10 },
    ])
  })

  it("rejects the event before persisting state when a meter would exceed the limit", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(createMeterDefinitions(), storage)

    await expect(
      engine.applyEvent(
        createPurchaseEvent({
          id: "evt_limit",
          timestamp: Date.now(),
          amount: 11,
        }),
        10
      )
    ).rejects.toThrow(LimitExceededError)

    expect(await storage.list<number>("meter-state:")).toEqual([])
  })
})

function createMeterDefinitions(): MeterDefinition[] {
  return [
    {
      id: "meter_sum",
      eventType: "purchase",
      aggregation: { type: "SUM", field: "amount" },
      enforcementMode: "hard",
    },
    {
      id: "meter_count",
      eventType: "purchase",
      aggregation: { type: "COUNT" },
      enforcementMode: "hard",
    },
    {
      id: "meter_max",
      eventType: "purchase",
      aggregation: { type: "MAX", field: "amount" },
      enforcementMode: "hard",
    },
    {
      id: "meter_latest",
      eventType: "purchase",
      aggregation: { type: "LATEST", field: "amount" },
      enforcementMode: "hard",
    },
  ]
}

function createPurchaseEvent({
  id,
  timestamp,
  amount,
}: {
  id: string
  timestamp: number
  amount: number
}): RawEvent {
  return {
    id,
    type: "purchase",
    timestamp,
    properties: {
      amount,
    },
  }
}
