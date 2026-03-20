import { Ok } from "@unprice/error"
import type { AppLogger } from "@unprice/observability"
import type { CustomerService } from "@unprice/services/customers"
import type { EntitlementService } from "@unprice/services/entitlements"
import { describe, expect, it, vi } from "vitest"
import type { Env } from "~/env"
import type { IngestionQueueMessage } from "./message"
import { IngestionService } from "./service"

describe("IngestionService", () => {
  it("acks duplicate messages from the same batch before the expensive processing path", async () => {
    const getCustomer = vi.fn().mockResolvedValue(Ok({ projectId: "proj_123" } as never))
    const getRelevantEntitlementsForIngestion = vi.fn().mockResolvedValue(Ok([]))
    const begin = vi.fn().mockResolvedValue({ decision: "process" as const })
    const complete = vi.fn().mockResolvedValue(undefined)
    const abort = vi.fn().mockResolvedValue(undefined)
    const apply = vi.fn().mockResolvedValue(undefined)
    const send = vi.fn().mockResolvedValue(undefined)
    const getIdempotencyStub = vi.fn().mockReturnValue({
      begin,
      complete,
      abort,
    })

    const service = new IngestionService({
      customerService: {
        getCustomer,
      } as unknown as Pick<CustomerService, "getCustomer">,
      entitlementService: {
        getRelevantEntitlementsForIngestion,
      } as unknown as Pick<EntitlementService, "getRelevantEntitlementsForIngestion">,
      env: {
        APP_ENV: "development",
        PIPELINE_EVENTS: {
          send,
        },
        entitlementwindow: {
          getByName: vi.fn().mockReturnValue({
            apply,
          }),
        },
        ingestionidempotency: {
          getByName: getIdempotencyStub,
        },
      } as unknown as Pick<
        Env,
        "APP_ENV" | "PIPELINE_EVENTS" | "entitlementwindow" | "ingestionidempotency"
      >,
      logger: createLoggerStub(),
    })

    const first = createBatchMessage({
      id: "evt_first",
      idempotencyKey: "idem_shared",
    })
    const duplicate = createBatchMessage({
      id: "evt_duplicate",
      idempotencyKey: "idem_shared",
    })

    await service.consumeBatch({
      messages: [first.message, duplicate.message],
    } as unknown as MessageBatch<IngestionQueueMessage>)

    expect(first.ack).toHaveBeenCalledTimes(1)
    expect(duplicate.ack).toHaveBeenCalledTimes(1)
    expect(first.retry).not.toHaveBeenCalled()
    expect(duplicate.retry).not.toHaveBeenCalled()
    expect(getCustomer).toHaveBeenCalledTimes(1)
    expect(getRelevantEntitlementsForIngestion).toHaveBeenCalledTimes(1)
    expect(getIdempotencyStub).toHaveBeenCalledTimes(1)
    expect(begin).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt_first",
        idempotency_key: "idem_shared",
        rejection_reason: "NO_MATCHING_ENTITLEMENT",
        state: "rejected",
      }),
    ])
    expect(apply).not.toHaveBeenCalled()
  })
})

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

function createLoggerStub(): AppLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger
}
