// src/observability/context.ts
import { AsyncLocalStorage } from "node:async_hooks"
import type { WideEvent } from "@unprice/logging"
import { setObservabilityProvider } from "@unprice/logging"

// Helper to map tRPC codes to HTTP status for analytics consistency
export function getHttpStatus(code: string): number {
  switch (code) {
    case "BAD_REQUEST":
      return 400
    case "UNAUTHORIZED":
      return 401
    case "FORBIDDEN":
      return 403
    case "NOT_FOUND":
      return 404
    case "TIMEOUT":
      return 408
    case "CONFLICT":
      return 409
    case "PRECONDITION_FAILED":
      return 412
    case "PAYLOAD_TOO_LARGE":
      return 413
    case "METHOD_NOT_SUPPORTED":
      return 405
    case "TOO_MANY_REQUESTS":
      return 429
    case "CLIENT_CLOSED_REQUEST":
      return 499
    default:
      return 500
  }
}

// 1. The Storage Mechanism
const storage = new AsyncLocalStorage<WideEvent>()

// 2. Initialize the Provider (Run this once at app startup)
export function initObservability() {
  setObservabilityProvider({
    add: (key, value) => {
      const event = storage.getStore()
      if (event) event.add(key, value)
    },
    get: () => storage.getStore()?.get(),
  })
}

// 3. Helper for Middleware
export function runInContext<T>(event: WideEvent, fn: () => Promise<T>): Promise<T> {
  return storage.run(event, fn)
}

// 4. Accessor (if needed directly in Hono)
export function getCurrentEvent() {
  return storage.getStore()
}
