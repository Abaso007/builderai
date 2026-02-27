# @unprice/react

DX-first React bindings for Unprice realtime entitlements.

This package is tokenless in the browser path: you do not pass Unprice API keys to `UnpriceProvider`.

## Installation

```bash
npm install @unprice/react
# or
yarn add @unprice/react
# or
pnpm add @unprice/react
```

## Quickstart

Set up everything in a single `UnpriceProvider` using a server-issued realtime ticket.

```tsx
import { UnpriceProvider } from "@unprice/react"

function App() {
  return (
    <UnpriceProvider
      realtime={{
        customerId: "cus_123",
        projectId: "proj_123",
        initialTicket: {
          ticket: "initial-realtime-ticket",
          expiresAt: 1735689600,
        },
        getRealtimeTicket: async ({ customerId, projectId, reason }) => {
          const response = await fetch("/api/unprice/realtime-ticket", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ customerId, projectId, reason }),
          })

          if (!response.ok) {
            throw new Error("Failed to refresh realtime ticket")
          }

          return await response.json()
        },
      }}
    >
      {/* Your app components */}
    </UnpriceProvider>
  )
}
```

## Feature Checks

### `useFeature`

```tsx
import { useFeature } from "@unprice/react"

function EditorFeature() {
  const feature = useFeature({ slug: "advanced-editor" })

  const onOpenEditor = async () => {
    const result = await feature.check({ action: "open-editor" })
    if (!result.allowed) return
    // open editor
  }

  return (
    <div>
      <p>Entitled: {String(feature.entitled)}</p>
      <p>Usage: {feature.usage ?? 0}</p>
      <button disabled={feature.isChecking} onClick={onOpenEditor}>
        Open editor
      </button>
    </div>
  )
}
```

### `FeatureGate`

```tsx
import { FeatureGate } from "@unprice/react"

function EditorRoute() {
  return (
    <FeatureGate slug="advanced-editor" fallback={<UpgradeModal />}>
      <AdvancedEditor />
    </FeatureGate>
  )
}
```

### `useCheckFeature`

Use this when you want to validate many feature slugs from one place.

```tsx
import { useCheckFeature } from "@unprice/react"

function FeatureAction() {
  const { check, isChecking } = useCheckFeature()

  const onClick = async () => {
    const result = await check({
      slug: "export-pdf",
      action: "export",
    })

    if (!result.allowed) {
      return
    }
  }

  return <button disabled={isChecking} onClick={onClick}>Export PDF</button>
}
```

### `useUnpriceUsage`

Use this to render usage rows for the current billing cycle from realtime snapshots.

```tsx
import { useUnpriceUsage } from "@unprice/react"

function EntitlementsUsageList() {
  const { rows } = useUnpriceUsage()

  return (
    <ul>
      {rows.map((row) => (
        <li key={row.featureSlug}>
          <strong>{row.featureSlug}</strong>{" "}
          {row.isFlatFeature
            ? "Flat feature"
            : row.hasLimit
              ? `${row.usage ?? 0} used of ${row.limit}`
              : `${row.usage ?? 0} used`}
        </li>
      ))}
    </ul>
  )
}
```

## Advanced APIs

- `UnpriceEntitlementsRealtimeProvider`
- `useUnpriceEntitlementsRealtime`
- `useUnpriceUsage`
- `useEntitlement`
- `useValidateEntitlement`
- `EntitlementRealtimeFeature`
- `EntitlementValidationListener`

## Security

- Do not expose root API keys in client code.
- Issue short-lived realtime tickets from your backend.
- Implement `getRealtimeTicket` in your app server and let the provider handle refresh/reconnect lifecycle.
