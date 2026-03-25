import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createDrain,
  createStandaloneRequestLogger,
  emitWideEvent,
  initObservability,
} from "./index"

describe("@unprice/observability", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    initObservability({
      env: {
        service: "test",
        environment: "test",
      },
      pretty: false,
      stringify: false,
      sampling: {
        rates: {
          debug: 100,
          info: 100,
          warn: 100,
          error: 100,
        },
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("promotes nested request metadata into evlog summary fields", () => {
    const { logger, requestLogger } = createStandaloneRequestLogger({
      method: "UNKNOWN",
      path: "/",
      requestId: "req_test",
    })

    logger.set({
      request: {
        method: "GET",
        path: "unknown",
        route: "/trpc/analytics.getRealtimeTicket",
        status: 200,
      },
    })

    const event = emitWideEvent(requestLogger)

    expect(event).toMatchObject({
      method: "GET",
      path: "/trpc/analytics.getRealtimeTicket",
      route: "/trpc/analytics.getRealtimeTicket",
      requestId: "req_test",
      status: 200,
      request: {
        id: "req_test",
        method: "GET",
        path: "unknown",
        route: "/trpc/analytics.getRealtimeTicket",
        status: 200,
      },
    })
  })

  it("keeps the transport method while replacing the summary path with the logical route", () => {
    const { logger, requestLogger } = createStandaloneRequestLogger({
      method: "POST",
      path: "/api/trpc/lambda",
      requestId: "req_transport",
    })

    logger.set({
      request: {
        method: "POST",
        path: "/api/trpc/lambda",
        route: "/trpc/analytics.getRealtimeTicket",
      },
    })

    const event = emitWideEvent(requestLogger)

    expect(event).toMatchObject({
      method: "POST",
      path: "/trpc/analytics.getRealtimeTicket",
      route: "/trpc/analytics.getRealtimeTicket",
      requestId: "req_transport",
    })
  })

  it("does not create a drain when token and dataset are missing", () => {
    const drain = createDrain({
      environment: "production",
    })

    expect(drain).toBeUndefined()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("creates a drain when token and dataset are present outside development", () => {
    const drain = createDrain({
      environment: "production",
      token: "xaat_test",
      dataset: "unprice-tests",
    })

    expect(drain).toBeTypeOf("function")
    expect(typeof drain?.flush).toBe("function")
  })

  it("warns once and skips drain for partial axiom config", () => {
    const firstAttempt = createDrain({
      environment: "production",
      token: "xaat_test",
    })

    const secondAttempt = createDrain({
      environment: "production",
      dataset: "unprice-tests",
    })

    expect(firstAttempt).toBeUndefined()
    expect(secondAttempt).toBeUndefined()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      "[observability] Axiom drain disabled: both AXIOM_API_TOKEN and AXIOM_DATASET are required."
    )
  })

  it("keeps logger.flush as a no-op when no drain adapter is provided", async () => {
    const { logger } = createStandaloneRequestLogger({
      method: "GET",
      path: "/health",
      requestId: "req_flush_noop",
    })

    await expect(logger.flush()).resolves.toBeUndefined()
  })
})
