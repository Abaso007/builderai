# @unprice/react

DX-first React bindings for Unprice.

Use one provider, then consume feature access with small hooks/components.

## Installation

```bash
npm install @unprice/react @unprice/api
# or
yarn add @unprice/react @unprice/api
# or
pnpm add @unprice/react @unprice/api
```

## Quickstart

Set up everything in a single `UnpriceProvider`:

```tsx
import { UnpriceProvider } from '@unprice/react'

function App() {
  return (
    <UnpriceProvider
      token="your-api-token"
      realtime={{
        customerId: "cus_123",
        projectId: "proj_123",
        token: "initial-realtime-ticket",
        tokenExpiresAt: 1735689600,
        refreshToken: async ({ customerId, projectId }) => {
          const response = await fetch('/api/unprice/realtime-ticket', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ customerId, projectId }),
          })

          if (!response.ok) {
            throw new Error('Failed to refresh realtime ticket')
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
      // paywall / toast / analytics
      return
    }
  }

  return <button disabled={isChecking} onClick={onClick}>Export PDF</button>
}
```

## Client Access

```tsx
import { useUnprice } from "@unprice/react"

function DebugPanel() {
  const client = useUnprice()

  const onRefresh = async () => {
    await client.customers.getEntitlements({
      customerId: "cus_123",
      projectId: "proj_123",
    })
  }

  return <button onClick={onRefresh}>Refresh</button>
}
```

## Advanced APIs

If you need lower-level control, these are still available:

- `UnpriceClientProvider`
- `useUnpriceClient`
- `UnpriceEntitlementsRealtimeProvider`
- `useUnpriceEntitlementsRealtime`
- `useEntitlement`
- `useValidateEntitlement`
- `EntitlementRealtimeFeature`
- `EntitlementValidationListener`

## TypeScript Support

This package includes TypeScript types and works seamlessly with TypeScript projects.

## Security

Do not expose root API keys in client code.

- Issue short-lived realtime tickets from your backend.
- Refresh tickets through a backend endpoint.
- Keep paywall/modal UI in your app components; this package provides data + hooks.
