"use client"

import type { Unprice, UnpriceOptions } from "@unprice/api"
import type { PropsWithChildren } from "react"
import { UnpriceClientProvider, useUnpriceClient } from "./context"
import {
  type EntitlementValidationEvent,
  type RealtimeTokenPayload,
  type RealtimeWindowSeconds,
  UnpriceEntitlementsRealtimeProvider,
} from "./realtime"

export type UnpriceRealtimeConfig = {
  customerId: string
  projectId: string
  runtimeEnv?: string
  apiBaseUrl?: string
  snapshotWindowSeconds?: RealtimeWindowSeconds
  token?: string | null
  tokenExpiresAt?: number | null
  refreshToken?: (params: {
    customerId: string
    projectId: string
  }) => Promise<RealtimeTokenPayload>
  onTokenRefresh?: (payload: RealtimeTokenPayload) => void
  allowClientSideTicketFetch?: boolean
  disableWebsocket?: boolean
  eventBufferSize?: number
  onValidationEvent?: (event: EntitlementValidationEvent) => void
}

export type UnpriceProviderProps = PropsWithChildren<{
  /**
   * Provide a pre-configured client if you need custom instantiation.
   */
  client?: Unprice
  /**
   * Pass raw client options when you need more than just a token.
   */
  options?: UnpriceOptions
  /**
   * Fast path for common setup.
   */
  token?: string
  /**
   * Optional realtime setup for entitlements + feature checks.
   */
  realtime?: UnpriceRealtimeConfig
}>

function resolveClientOptions(params: {
  options?: UnpriceOptions
  token?: string
}): UnpriceOptions | undefined {
  if (params.options) {
    if (params.token) {
      return {
        ...params.options,
        token: params.token,
      }
    }
    return params.options
  }

  if (!params.token) {
    return undefined
  }

  return { token: params.token } as UnpriceOptions
}

function renderRealtimeLayer(params: {
  children: PropsWithChildren["children"]
  realtime?: UnpriceRealtimeConfig
}) {
  if (!params.realtime) {
    return params.children
  }

  const realtime = params.realtime
  return (
    <UnpriceEntitlementsRealtimeProvider
      customerId={realtime.customerId}
      projectId={realtime.projectId}
      runtimeEnv={realtime.runtimeEnv}
      apiBaseUrl={realtime.apiBaseUrl}
      snapshotWindowSeconds={realtime.snapshotWindowSeconds}
      realtimeToken={realtime.token}
      realtimeTokenExpiresAt={realtime.tokenExpiresAt}
      refreshRealtimeToken={realtime.refreshToken}
      onRealtimeTokenRefresh={realtime.onTokenRefresh}
      allowClientSideTicketFetch={realtime.allowClientSideTicketFetch}
      disableWebsocket={realtime.disableWebsocket}
      eventBufferSize={realtime.eventBufferSize}
      onValidationEvent={realtime.onValidationEvent}
    >
      {params.children}
    </UnpriceEntitlementsRealtimeProvider>
  )
}

export function UnpriceProvider({
  children,
  client,
  options,
  token,
  realtime,
}: UnpriceProviderProps) {
  const resolvedOptions = resolveClientOptions({ options, token })

  if (!client && !resolvedOptions?.token) {
    throw new Error("UnpriceProvider requires `client`, `token`, or `options.token`.")
  }

  return (
    <UnpriceClientProvider client={client} options={resolvedOptions}>
      {renderRealtimeLayer({
        children,
        realtime,
      })}
    </UnpriceClientProvider>
  )
}

export function useUnprice() {
  return useUnpriceClient().client
}
