import { calculateCycleWindow } from "@unprice/db/validators"
import { BaseError } from "@unprice/error"

export const MAX_FUTURE_EVENT_SKEW_MS = 5_000
export const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1_000

export interface RawEvent {
  id: string
  type: string
  timestamp: number
  properties: Record<string, unknown>
}

// TODO: implement this later
// type AggregationType = 'SUM' | 'COUNT' | 'MAX' | 'UNIQUE_COUNT' | 'LATEST';

// interface RawEvent {
//   id: string;           // idempotency key
//   customerId: string;
//   type: string;         // "ai_inference", "storage_write", etc.
//   timestamp: string;
//   properties: Record<string, string | number>; // open schema - capture everything
// }

// interface Meter {
//   id: string;
//   slug: string;               // e.g. "ai_tokens_used"
//   eventType: string;          // matches raw event's `type` field
//   aggregation: {
//     type: AggregationType;
//     field?: string;           // which property from the event payload to aggregate
//   };
//   filters?: Record<string, string[]>;  // e.g. { model: ['gpt-4o', 'gpt-4'] }
//   groupBy?: string[];         // e.g. ['model', 'region'] for drill-down
//   windowSize?: 'MINUTE' | 'HOUR' | 'DAY';  // pre-aggregation granularity
// }

export interface MeterDefinition {
  id: string
  eventType: string
  aggregation: {
    type: "SUM" | "COUNT" | "MAX" | "LATEST"
    field?: string
  }
  enforcementMode: "hard" | "soft"
}

export interface Fact {
  eventId: string
  meterId: string
  delta: number
  valueAfter: number
}

export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>
  put<T>(key: string, value: T): Promise<void>
  list<T>(prefix: string): Promise<T[]>
}

export interface SyncStorageAdapter {
  getSync<T>(key: string): T | null
  putSync<T>(key: string, value: T): void
  listSync<T>(prefix: string): T[]
}

export class LimitExceededError extends BaseError<{
  eventId: string
  meterId: string
  limit: number
  valueAfter: number
}> {
  public readonly retry = false
  public readonly name = LimitExceededError.name

  constructor(params: { eventId: string; meterId: string; limit: number; valueAfter: number }) {
    super({
      message: `Limit exceeded for meter ${params.meterId}`,
      context: params,
    })
  }
}

export class EventTimestampTooFarInFutureError extends BaseError<{
  eventTimeMs: number
  serverTimeMs: number
  maxFutureSkewMs: number
}> {
  public readonly retry = false
  public readonly name = EventTimestampTooFarInFutureError.name

  constructor(eventTimeMs: number, serverTimeMs: number) {
    super({
      message: "Event timestamp is too far in the future",
      context: {
        eventTimeMs,
        serverTimeMs,
        maxFutureSkewMs: MAX_FUTURE_EVENT_SKEW_MS,
      },
    })
  }
}

export class EventTimestampTooOldError extends BaseError<{
  eventTimeMs: number
  serverTimeMs: number
  maxEventAgeMs: number
}> {
  public readonly retry = false
  public readonly name = EventTimestampTooOldError.name

  constructor(eventTimeMs: number, serverTimeMs: number) {
    super({
      message: "Event timestamp is older than the maximum accepted age",
      context: {
        eventTimeMs,
        serverTimeMs,
        maxEventAgeMs: MAX_EVENT_AGE_MS,
      },
    })
  }
}

export class PeriodKeyComputationError extends BaseError<{
  now: number
  effectiveStartDate: number
  effectiveEndDate: number | null
  interval: Parameters<typeof calculateCycleWindow>[0]["config"]["interval"]
}> {
  public readonly retry = false
  public readonly name = PeriodKeyComputationError.name

  constructor(params: Parameters<typeof calculateCycleWindow>[0]) {
    super({
      message: "Unable to compute a period key for an inactive cycle",
      context: {
        now: params.now,
        effectiveStartDate: params.effectiveStartDate,
        effectiveEndDate: params.effectiveEndDate,
        interval: params.config.interval,
      },
    })
  }
}

export function validateEventTimestamp(eventTimeMs: number, serverTimeMs: number): void {
  if (eventTimeMs - serverTimeMs >= MAX_FUTURE_EVENT_SKEW_MS) {
    throw new EventTimestampTooFarInFutureError(eventTimeMs, serverTimeMs)
  }

  if (serverTimeMs - eventTimeMs > MAX_EVENT_AGE_MS) {
    throw new EventTimestampTooOldError(eventTimeMs, serverTimeMs)
  }
}

export function computePeriodKey(params: Parameters<typeof calculateCycleWindow>[0]): string {
  const cycle = calculateCycleWindow(params)

  if (!cycle) {
    throw new PeriodKeyComputationError(params)
  }

  return `${params.config.interval}:${cycle.start}`
}
