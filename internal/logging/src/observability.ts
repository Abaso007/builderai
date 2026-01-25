import type { WideEventContext } from "./wide-event"

// 1. The Interface
export interface ObservabilityProvider {
  add(key: string, value: unknown): void
  get(): WideEventContext | undefined
}

// 2. The Default "No-Op" Provider (Safe by default)
let currentProvider: ObservabilityProvider = {
  add: () => {}, // Doing nothing is safer than crashing
  get: () => undefined,
}

// 3. Dependency Injection (Used by Hono/API)
export const setObservabilityProvider = (provider: ObservabilityProvider) => {
  currentProvider = provider
}

// 4. The Public API (Used by Services)
export const obs = {
  add: (key: string, value: unknown) => currentProvider.add(key, value),
  get: () => currentProvider.get(),
}
