"use client"

import type { PropsWithChildren } from "react"
import {
  type EntitlementValidationEvent,
  type RealtimeAlertEvent,
  type RealtimeStreamMode,
  type RealtimeTokenPayload,
  type RealtimeWindowSeconds,
  type SubscriptionStatus,
  UnpriceEntitlementsRealtimeProvider,
} from "./realtime"

export type RealtimeTicketReason = "init" | "pre_expiry" | "expired" | "reconnect" | "manual"

export type UnpriceRealtimeConfig = {
  customerId: string
  projectId: string
  runtimeEnv?: string
  apiBaseUrl?: string
  snapshotWindowSeconds?: RealtimeWindowSeconds
  initialTicket?: RealtimeTokenPayload | null
  getRealtimeTicket: (params: {
    customerId: string
    projectId: string
    reason: RealtimeTicketReason
    currentExpiresAt: number | null
  }) => Promise<RealtimeTokenPayload>
  onTokenRefresh?: (payload: RealtimeTokenPayload) => void
  refreshLeadSeconds?: number
  snapshotStaleThresholdMs?: number
  snapshotRetryIntervalMs?: number
  disableWebsocket?: boolean
  eventBufferSize?: number
  stream?: RealtimeStreamMode
  onValidationEvent?: (event: EntitlementValidationEvent) => void
  onAlertEvent?: (event: RealtimeAlertEvent) => void
  onConnectionStateChange?: (value: {
    status: "idle" | "connecting" | "open" | "closed" | "error"
    attempts: number
    lastError: string | null
  }) => void
}

export type UnpriceProviderProps = PropsWithChildren<{
  realtime: UnpriceRealtimeConfig
}>

export type { SubscriptionStatus }

export function UnpriceProvider({ children, realtime }: UnpriceProviderProps) {
  return (
    <UnpriceEntitlementsRealtimeProvider
      customerId={realtime.customerId}
      projectId={realtime.projectId}
      runtimeEnv={realtime.runtimeEnv}
      apiBaseUrl={realtime.apiBaseUrl}
      snapshotWindowSeconds={realtime.snapshotWindowSeconds}
      initialRealtimeToken={realtime.initialTicket?.ticket ?? null}
      initialRealtimeTokenExpiresAt={realtime.initialTicket?.expiresAt ?? null}
      getRealtimeTicket={realtime.getRealtimeTicket}
      onRealtimeTokenRefresh={realtime.onTokenRefresh}
      refreshLeadSeconds={realtime.refreshLeadSeconds}
      snapshotStaleThresholdMs={realtime.snapshotStaleThresholdMs}
      snapshotRetryIntervalMs={realtime.snapshotRetryIntervalMs}
      disableWebsocket={realtime.disableWebsocket}
      eventBufferSize={realtime.eventBufferSize}
      stream={realtime.stream}
      onValidationEvent={realtime.onValidationEvent}
      onAlertEvent={realtime.onAlertEvent}
      onConnectionStateChange={realtime.onConnectionStateChange}
    >
      {children}
    </UnpriceEntitlementsRealtimeProvider>
  )
}
