import { Ok } from "@unprice/error"
import type { AppLogger } from "@unprice/observability"
import type { CustomerService } from "@unprice/services/customers"
import type { GrantsManager } from "@unprice/services/entitlements"
import { describe, expect, it, vi } from "vitest"
import { IngestionQueueConsumer } from "./consumer"
import type { IngestionQueueMessage } from "./message"
import { IngestionService } from "./service"

vi.mock("@unprice/lakehouse", () => ({
  getLakehouseSourceCurrentVersion: vi.fn(() => 1),
  parseLakehouseEvent: vi.fn((_source: string, payload: unknown) => payload),
}))

type LoggerStub = {
  debug: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
}

type HarnessOptions = {
  apply?: ReturnType<typeof vi.fn>
  beginResult?:
    | {
        decision: "busy"
        retryAfterSeconds?: number
      }
    | {
        decision: "duplicate"
      }
    | {
        decision: "process"
      }
  customer?: {
    projectId: string
  } | null
  grants?: unknown[]
  resolvedFeatureState?: unknown
  resolvedStates?: unknown[]
  send?: ReturnType<typeof vi.fn>
  getEnforcementState?: ReturnType<typeof vi.fn>
}

describe("IngestionService", () => {
  it("drops malformed queue messages and acks them", async () => {
    const { consumer, mocks } = createServiceHarness()
    const malformed = createRawBatchMessage({
      customerId: "cus_123",
      projectId: "proj_123",
    })

    await consumer.consumeBatch({
      messages: [malformed.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(malformed.ack).toHaveBeenCalledTimes(1)
    expect(malformed.retry).not.toHaveBeenCalled()
    expect(mocks.getCustomer).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "dropping malformed ingestion queue message",
      expect.objectContaining({
        errors: expect.any(Array),
      })
    )
  })

  it("acks duplicate messages from the same batch before the expensive processing path", async () => {
    const { consumer, mocks } = createServiceHarness()
    const first = createBatchMessage({
      id: "evt_first",
      idempotencyKey: "idem_shared",
    })
    const duplicate = createBatchMessage({
      id: "evt_duplicate",
      idempotencyKey: "idem_shared",
    })

    await consumer.consumeBatch({
      messages: [first.message, duplicate.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(first.ack).toHaveBeenCalledTimes(1)
    expect(duplicate.ack).toHaveBeenCalledTimes(1)
    expect(first.retry).not.toHaveBeenCalled()
    expect(duplicate.retry).not.toHaveBeenCalled()
    expect(mocks.getCustomer).toHaveBeenCalledTimes(1)
    expect(mocks.getGrantsForCustomer).toHaveBeenCalledTimes(1)
    expect(mocks.getIdempotencyStub).toHaveBeenCalledTimes(1)
    expect(mocks.begin).toHaveBeenCalledTimes(1)
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_first",
        idempotency_key: "idem_shared",
        rejection_reason: "NO_MATCHING_ENTITLEMENT",
        state: "rejected",
      }),
    ])
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("publishes a rejected audit event without claiming idempotency when the customer is missing", async () => {
    const { consumer, mocks } = createServiceHarness({
      customer: null,
    })
    const message = createBatchMessage({
      id: "evt_missing_customer",
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(mocks.getCustomer).toHaveBeenCalledTimes(1)
    expect(mocks.getGrantsForCustomer).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.abort).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_missing_customer",
        rejection_reason: "CUSTOMER_NOT_FOUND",
        state: "rejected",
      }),
    ])
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("acks duplicate idempotency claims without publishing audit events", async () => {
    const { consumer, mocks } = createServiceHarness({
      beginResult: {
        decision: "duplicate",
      },
    })
    const message = createBatchMessage({
      id: "evt_duplicate_claim",
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.resolveIngestionStatesFromGrants).not.toHaveBeenCalled()
  })

  it("retries busy idempotency claims with the provided delay", async () => {
    const { consumer, mocks } = createServiceHarness({
      beginResult: {
        decision: "busy",
        retryAfterSeconds: 12,
      },
    })
    const message = createBatchMessage({
      id: "evt_busy_claim",
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledTimes(1)
    expect(message.retry).toHaveBeenCalledWith({
      delaySeconds: 12,
    })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.abort).not.toHaveBeenCalled()
  })

  it("routes processable events through a stable stream identity", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const message = createBatchMessage({
      id: "evt_stream",
      idempotencyKey: "idem_stream",
      timestamp,
      properties: {
        amount: 7,
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(mocks.getGrantsForCustomer).toHaveBeenCalledTimes(1)
    expect(mocks.resolveIngestionStatesFromGrants).toHaveBeenCalledTimes(1)
    expect(mocks.getEntitlementWindowStub).toHaveBeenCalledTimes(1)
    expect(mocks.getEntitlementWindowStub.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        streamId: "stream_123",
      })
    )
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "stream_123",
        featureSlug: "api_calls",
        limit: 100,
      })
    )
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_stream",
        state: "processed",
      }),
    ])
  })

  it("aborts claimed idempotency and retries when processing fails after the claim", async () => {
    const send = vi.fn().mockRejectedValue(new Error("send failed"))
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState()],
      send,
    })
    const message = createBatchMessage({
      id: "evt_processing_failure",
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(mocks.begin).toHaveBeenCalledTimes(1)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.abort).toHaveBeenCalledWith({
      idempotencyKey: "idem_123",
    })
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledTimes(1)
  })

  it("rejects invalid aggregation payloads without calling the entitlement DO", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const message = createBatchMessage({
      id: "evt_invalid_aggregation",
      timestamp,
      properties: {},
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(mocks.resolveIngestionStatesFromGrants).toHaveBeenCalledTimes(1)
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_invalid_aggregation",
        rejection_reason: "INVALID_AGGREGATION_PROPERTIES",
        state: "rejected",
      }),
    ])
  })

  it("accepts parseable numeric-string aggregation payloads and processes the event", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const message = createBatchMessage({
      id: "evt_valid_numeric_string_aggregation",
      timestamp,
      properties: {
        amount: "4.5",
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(mocks.resolveIngestionStatesFromGrants).toHaveBeenCalledTimes(1)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_valid_numeric_string_aggregation",
        state: "processed",
      }),
    ])
  })

  it("ingests a single feature synchronously without the outer idempotency claim", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedFeatureState: createUsageFeatureState(createResolvedState(timestamp)),
    })
    const message = createBatchMessage({
      id: "evt_sync_feature",
      timestamp,
      properties: {
        amount: 5,
      },
    }).message.body

    const result = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message,
    })

    expect(result).toEqual({
      allowed: true,
      message: undefined,
      rejectionReason: undefined,
      state: "processed",
    })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.resolveFeatureStateAtTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_123",
        featureSlug: "api_calls",
        projectId: "proj_123",
        timestamp,
      })
    )
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        enforceLimit: true,
        featureSlug: "api_calls",
      })
    )
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_sync_feature",
        state: "processed",
      }),
    ])
  })

  it("ingests a single feature synchronously with parseable numeric-string payloads", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedFeatureState: createUsageFeatureState(createResolvedState(timestamp)),
    })
    const message = createBatchMessage({
      id: "evt_sync_feature_numeric_string",
      timestamp,
      properties: {
        amount: "5.75",
      },
    }).message.body

    const result = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message,
    })

    expect(result).toEqual({
      allowed: true,
      message: undefined,
      rejectionReason: undefined,
      state: "processed",
    })
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        enforceLimit: true,
        featureSlug: "api_calls",
      })
    )
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_sync_feature_numeric_string",
        state: "processed",
      }),
    ])
  })

  it("rejects synchronous feature ingestion when the limit is exceeded", async () => {
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedFeatureState: createUsageFeatureState(createResolvedState()),
      apply: vi.fn().mockResolvedValue({
        allowed: false,
        deniedReason: "LIMIT_EXCEEDED",
        message: "Limit exceeded for meter meter_123",
      }),
    })
    const message = createBatchMessage({
      id: "evt_sync_denied",
    }).message.body

    const result = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message,
    })

    expect(result).toEqual({
      allowed: false,
      message: "Limit exceeded for meter meter_123",
      rejectionReason: "LIMIT_EXCEEDED",
      state: "rejected",
    })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_sync_denied",
        rejection_reason: "LIMIT_EXCEEDED",
        state: "rejected",
      }),
    ])
  })

  it("rejects synchronous feature ingestion when the customer is missing", async () => {
    const { service, mocks } = createServiceHarness({
      customer: null,
    })
    const message = createBatchMessage({
      id: "evt_sync_missing_customer",
    }).message.body

    const result = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message,
    })

    expect(result).toEqual({
      allowed: false,
      message: undefined,
      rejectionReason: "CUSTOMER_NOT_FOUND",
      state: "rejected",
    })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_sync_missing_customer",
        rejection_reason: "CUSTOMER_NOT_FOUND",
        state: "rejected",
      }),
    ])
  })

  it("returns the live usage snapshot for a usage feature", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedFeatureState: createUsageFeatureState(createResolvedState(timestamp)),
      getEnforcementState: vi.fn().mockResolvedValue({
        isLimitReached: false,
        limit: 100,
        usage: 42,
      }),
    })

    const result = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp,
    })

    expect(result).toEqual({
      allowed: true,
      featureSlug: "api_calls",
      featureType: "usage",
      isLimitReached: false,
      limit: 100,
      meterConfig: {
        eventId: "meter_123",
        eventSlug: "tokens_used",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
      overageStrategy: "none",
      periodKey: `onetime:${timestamp}`,
      status: "usage",
      streamEndAt: null,
      streamId: "stream_123",
      streamStartAt: timestamp,
      timestamp,
      usage: 42,
    })
    expect(mocks.getEnforcementState).toHaveBeenCalledWith({
      limit: 100,
      meterConfig: {
        eventId: "meter_123",
        eventSlug: "tokens_used",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
      overageStrategy: "none",
    })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("returns an active non-usage feature without meter state", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { service, mocks } = createServiceHarness({
      grants: [createBooleanGrant()],
      resolvedFeatureState: {
        kind: "non_usage",
        entitlement: {
          featureType: "boolean",
        },
      },
    })

    const result = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "team_members",
      projectId: "proj_123",
      timestamp,
    })

    expect(result).toEqual({
      allowed: true,
      featureSlug: "team_members",
      featureType: "boolean",
      status: "non_usage",
      timestamp,
    })
    expect(mocks.getEnforcementState).not.toHaveBeenCalled()
  })
})

function createServiceHarness(options: HarnessOptions = {}) {
  const getCustomer = vi
    .fn()
    .mockResolvedValue(
      Ok((options.customer === undefined ? { projectId: "proj_123" } : options.customer) as never)
    )
  const getGrantsForCustomer = vi.fn().mockResolvedValue(
    Ok({
      grants: options.grants ?? [],
    } as never)
  )
  const resolveIngestionStatesFromGrants = vi
    .fn()
    .mockResolvedValue(Ok((options.resolvedStates ?? []) as never))
  const resolveFeatureStateAtTimestamp = vi
    .fn()
    .mockResolvedValue(
      Ok((options.resolvedFeatureState ?? createUsageFeatureState(createResolvedState())) as never)
    )
  const begin = vi.fn().mockResolvedValue(options.beginResult ?? { decision: "process" as const })
  const complete = vi.fn().mockResolvedValue(undefined)
  const abort = vi.fn().mockResolvedValue(undefined)
  const apply = options.apply ?? vi.fn().mockResolvedValue({ allowed: true })
  const getEnforcementState =
    options.getEnforcementState ??
    vi.fn().mockResolvedValue({
      isLimitReached: false,
      limit: 100,
      usage: 0,
    })
  const send = options.send ?? vi.fn().mockResolvedValue(undefined)
  const logger = createLoggerStub()
  const getIdempotencyStub = vi.fn().mockReturnValue({
    begin,
    complete,
    abort,
  })
  const getEntitlementWindowStub = vi.fn().mockReturnValue({
    apply,
    getEnforcementState,
  })

  const service = new IngestionService({
    customerService: {
      getCustomer,
    } as unknown as Pick<CustomerService, "getCustomer">,
    entitlementWindowClient: {
      getEntitlementWindowStub,
    },
    grantsManager: {
      getGrantsForCustomer,
      resolveFeatureStateAtTimestamp,
      resolveIngestionStatesFromGrants,
    } as unknown as Pick<
      GrantsManager,
      "getGrantsForCustomer" | "resolveFeatureStateAtTimestamp" | "resolveIngestionStatesFromGrants"
    >,
    idempotencyClient: {
      getIdempotencyStub,
    },
    logger,
    pipelineEvents: {
      send,
    },
  })

  const consumer = new IngestionQueueConsumer({
    logger,
    processor: service,
  })

  return {
    consumer,
    service,
    mocks: {
      abort,
      apply,
      begin,
      complete,
      getCustomer,
      getEntitlementWindowStub,
      getEnforcementState,
      getGrantsForCustomer,
      getIdempotencyStub,
      logger,
      resolveFeatureStateAtTimestamp,
      resolveIngestionStatesFromGrants,
      send,
    },
  }
}

function createUsageGrant() {
  return {
    featurePlanVersion: {
      feature: {
        slug: "api_calls",
      },
      featureType: "usage",
      meterConfig: {
        eventId: "meter_123",
      },
    },
  }
}

function createBooleanGrant() {
  return {
    featurePlanVersion: {
      feature: {
        slug: "team_members",
      },
      featureType: "boolean",
      meterConfig: null,
    },
  }
}

function createResolvedState(
  timestamp = Date.UTC(2026, 2, 19, 12, 0, 0),
  overrides: Record<string, unknown> = {}
) {
  return {
    activeGrantIds: ["grant_123"],
    customerId: "cus_123",
    featureSlug: "api_calls",
    limit: 100,
    meterConfig: {
      eventId: "meter_123",
      eventSlug: "tokens_used",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    streamEndAt: null,
    streamId: "stream_123",
    streamStartAt: timestamp,
    ...overrides,
  }
}

function createUsageFeatureState(state = createResolvedState()) {
  return {
    kind: "usage",
    state,
  }
}

function createBatchMessage(overrides: Partial<IngestionQueueMessage> = {}): {
  ack: ReturnType<typeof vi.fn>
  message: {
    body: IngestionQueueMessage
    ack: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
  }
  retry: ReturnType<typeof vi.fn>
} {
  const ack = vi.fn()
  const retry = vi.fn()

  return {
    ack,
    retry,
    message: {
      ack,
      retry,
      body: {
        version: 1,
        projectId: "proj_123",
        customerId: "cus_123",
        requestId: "req_123",
        receivedAt: Date.UTC(2026, 2, 19, 12, 0, 0),
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "tokens_used",
        timestamp: Date.UTC(2026, 2, 19, 12, 0, 0),
        properties: {
          amount: 1,
        },
        ...overrides,
      },
    },
  }
}

function createRawBatchMessage(body: unknown): {
  ack: ReturnType<typeof vi.fn>
  message: {
    body: unknown
    ack: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
  }
  retry: ReturnType<typeof vi.fn>
} {
  const ack = vi.fn()
  const retry = vi.fn()

  return {
    ack,
    retry,
    message: {
      ack,
      retry,
      body,
    },
  }
}

function createLoggerStub(): AppLogger & LoggerStub {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger & LoggerStub
}
