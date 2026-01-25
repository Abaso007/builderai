import { AsyncLocalStorage } from "node:async_hooks"
import { type WideEvent, setObservabilityProvider } from "@unprice/logging"

// 1. The Storage
const storage = new AsyncLocalStorage<WideEvent>()

// 2. The Real Implementation
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
