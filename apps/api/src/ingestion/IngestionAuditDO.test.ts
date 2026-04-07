import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IngestionAuditDO } from "./IngestionAuditDO"

vi.mock("@unprice/lakehouse", () => ({
  parseLakehouseEvent: vi.fn((_source: string, payload: unknown) => payload),
}))

vi.mock("@unprice/observability", () => ({
  createStandaloneRequestLogger: vi.fn(() => ({
    logger: {
      debug: vi.fn(),
      emit: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
      info: vi.fn(),
      set: vi.fn(),
      warn: vi.fn(),
    },
  })),
}))

vi.mock("~/observability", () => ({
  apiDrain: null,
}))

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: FakeDurableObjectState

    constructor(state: FakeDurableObjectState) {
      this.ctx = state
    }
  },
}))

describe("IngestionAuditDO", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 2, 19, 12, 0, 0))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("counts duplicate and conflicting audit rows without inserting twice", async () => {
    const state = createDurableObjectState()
    const pipelineEvents = {
      send: vi.fn(),
    }
    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: pipelineEvents,
      } as never
    )

    const result = await durableObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_shared",
        payloadHash: "hash_a",
      }),
      createLedgerEntry({
        idempotencyKey: "idem_shared",
        payloadHash: "hash_a",
      }),
      createLedgerEntry({
        idempotencyKey: "idem_shared",
        payloadHash: "hash_b",
      }),
    ])

    expect(result).toEqual({
      inserted: 1,
      duplicates: 1,
      conflicts: 1,
    })
    expect(state.rows.size).toBe(1)
    expect(state.alarmAt).toBe(Date.UTC(2026, 2, 19, 12, 0, 1))
  })
})

type FakeLedgerRow = {
  audit_payload_json: string
  canonical_audit_id: string
  first_seen_at: number
  idempotency_key: string
  payload_hash: string
  published_at: number | null
  rejection_reason: string | null
  result_json: string
  status: "processed" | "rejected"
}

type FakeDurableObjectState = {
  alarmAt: number | null
  blockConcurrencyWhile: <T>(callback: () => Promise<T> | T) => Promise<T>
  id: { toString: () => string }
  rows: Map<string, FakeLedgerRow>
  storage: {
    getAlarm: () => Promise<number | null>
    setAlarm: (timestamp: number) => Promise<void>
    sql: {
      exec: <T>(query: string, ...params: unknown[]) => { toArray: () => T[] }
    }
  }
}

function createDurableObjectState(): FakeDurableObjectState {
  const rows = new Map<string, FakeLedgerRow>()

  const state: FakeDurableObjectState = {
    alarmAt: null,
    id: { toString: () => "do_audit_123" },
    rows,
    blockConcurrencyWhile: async (callback) => await callback(),
    storage: {
      getAlarm: async () => state.alarmAt,
      setAlarm: async (timestamp) => {
        state.alarmAt = timestamp
      },
      sql: {
        exec: <T>(query: string, ...params: unknown[]) => execSql<T>(rows, query, params),
      },
    },
  }

  return state
}

function execSql<T>(
  rows: Map<string, FakeLedgerRow>,
  query: string,
  params: unknown[]
): { toArray: () => T[] } {
  const normalizedQuery = query.replace(/\s+/g, " ").trim()

  if (
    normalizedQuery.startsWith("CREATE TABLE IF NOT EXISTS") ||
    normalizedQuery.startsWith("CREATE INDEX IF NOT EXISTS")
  ) {
    return toArrayResult([])
  }

  if (
    normalizedQuery.startsWith("SELECT payload_hash FROM ingestion_audit WHERE idempotency_key = ?")
  ) {
    const row = rows.get(params[0] as string)
    return toArrayResult(row ? ([{ payload_hash: row.payload_hash }] as T[]) : [])
  }

  if (normalizedQuery.startsWith("INSERT INTO ingestion_audit")) {
    const idempotencyKey = params[0] as string

    if (!rows.has(idempotencyKey)) {
      rows.set(idempotencyKey, {
        idempotency_key: idempotencyKey,
        canonical_audit_id: params[1] as string,
        payload_hash: params[2] as string,
        status: params[3] as "processed" | "rejected",
        rejection_reason: (params[4] as string | null) ?? null,
        result_json: params[5] as string,
        audit_payload_json: params[6] as string,
        first_seen_at: params[7] as number,
        published_at: null,
      })
    }

    return toArrayResult([])
  }

  throw new Error(`Unsupported SQL in test: ${normalizedQuery}`)
}

function toArrayResult<T>(rows: T[]) {
  return {
    toArray: () => rows,
  }
}

function createLedgerEntry(overrides: {
  idempotencyKey: string
  payloadHash: string
}) {
  return {
    auditPayloadJson: JSON.stringify({
      idempotency_key: overrides.idempotencyKey,
    }),
    canonicalAuditId: `canonical_${overrides.idempotencyKey}`,
    firstSeenAt: Date.UTC(2026, 2, 19, 12, 0, 0),
    idempotencyKey: overrides.idempotencyKey,
    payloadHash: overrides.payloadHash,
    resultJson: JSON.stringify({ state: "processed" }),
    status: "processed" as const,
  }
}
