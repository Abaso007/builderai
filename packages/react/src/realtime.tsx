"use client"

import type { paths } from "@unprice/api/src/openapi"
import { usePartySocket } from "partysocket/react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { PropsWithChildren, ReactNode } from "react"
import { useUnpriceClient } from "./context"

const SNAPSHOT_REQUEST_THROTTLE_MS = 1_500
const TOKEN_REFRESH_LEAD_SECONDS = 30
const DEFAULT_EVENT_BUFFER_SIZE = 50
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"
const VERIFY_REQUEST_TIMEOUT_MS = 7_000

export type RealtimeWindowSeconds = 300 | 3600 | 86400 | 604800
type RealtimeMetrics =
  paths["/v1/analytics/realtime"]["post"]["responses"]["200"]["content"]["application/json"]["metrics"]
type CustomerEntitlement =
  paths["/v1/customer/getEntitlements"]["post"]["responses"]["200"]["content"]["application/json"][number]
export type VerifyEntitlementInput =
  paths["/v1/customer/verify"]["post"]["requestBody"]["content"]["application/json"]
export type VerifyEntitlementResult =
  paths["/v1/customer/verify"]["post"]["responses"]["200"]["content"]["application/json"]

type SocketStatus = "idle" | "connecting" | "open" | "closed" | "error"
type RealtimeEventType = "verify" | "reportUsage"
type EventSource = "socket" | "hook"

type SocketSender = {
  send: (message: string) => void
  readyState: number
}

type PendingVerifyRequest = {
  resolve: (result: VerifyEntitlementResult) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

export type RealtimeTokenPayload = {
  ticket: string
  expiresAt: number | null
}

export type EntitlementRealtimeEvent = {
  at: number
  type: RealtimeEventType
  featureSlug: string
  success: boolean
  usage?: number
  limit?: number
  deniedReason?: VerifyEntitlementResult["deniedReason"]
  latencyMs?: number
  source: EventSource
}

export type EntitlementValidationEvent = {
  at: number
  featureSlug: string
  allowed: boolean
  deniedReason?: VerifyEntitlementResult["deniedReason"]
  usage?: number
  limit?: number
  message?: string
  source: EventSource
}

export type UnpriceEntitlementsRealtimeProviderProps = PropsWithChildren<{
  customerId: string
  projectId: string
  runtimeEnv?: string
  apiBaseUrl?: string
  snapshotWindowSeconds?: RealtimeWindowSeconds
  realtimeToken?: string | null
  realtimeTokenExpiresAt?: number | null
  refreshRealtimeToken?: (params: {
    customerId: string
    projectId: string
  }) => Promise<RealtimeTokenPayload>
  onRealtimeTokenRefresh?: (payload: RealtimeTokenPayload) => void
  allowClientSideTicketFetch?: boolean
  disableWebsocket?: boolean
  eventBufferSize?: number
  onValidationEvent?: (event: EntitlementValidationEvent) => void
}>

type EntitlementsRealtimeContextValue = {
  customerId: string
  projectId: string
  entitlements: CustomerEntitlement[]
  entitlementSlugs: Set<string>
  entitlementByFeatureSlug: Map<string, CustomerEntitlement>
  usageByFeature: Record<string, number>
  metrics: RealtimeMetrics | null
  events: EntitlementRealtimeEvent[]
  validationsByFeature: Record<string, EntitlementValidationEvent>
  lastValidationEvent: EntitlementValidationEvent | null
  socketStatus: SocketStatus
  isConnected: boolean
  isRefreshingToken: boolean
  isRefreshingEntitlements: boolean
  error: Error | null
  refreshEntitlements: () => Promise<void>
  refreshRealtimeToken: () => Promise<void>
  validateEntitlement: (input: VerifyEntitlementInput) => Promise<VerifyEntitlementResult>
}

export type UseEntitlementResult = {
  featureSlug: string
  entitlement: CustomerEntitlement | null
  isEntitled: boolean
  isAllowed: boolean
  shouldRenderPaywall: boolean
  usage: number | null
  lastValidation: EntitlementValidationEvent | null
  validate: (
    input?: Omit<VerifyEntitlementInput, "featureSlug">
  ) => Promise<VerifyEntitlementResult>
}

const EntitlementsRealtimeContext = createContext<EntitlementsRealtimeContextValue | undefined>(
  undefined
)

function normalizeEpochSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null
  }

  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

function toWebSocketBaseUrl(input: string): string {
  const normalized = input.trim().replace(/\/+$/, "")

  if (normalized.startsWith("wss://") || normalized.startsWith("ws://")) {
    return normalized
  }

  if (normalized.startsWith("https://")) {
    return `wss://${normalized.slice("https://".length)}`
  }

  if (normalized.startsWith("http://")) {
    return `ws://${normalized.slice("http://".length)}`
  }

  return `wss://${normalized.replace(/^\/+/, "")}`
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(fallbackMessage)
}

function createVerifyRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `verify_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

export function UnpriceEntitlementsRealtimeProvider({
  children,
  customerId,
  projectId,
  runtimeEnv = "sdk",
  apiBaseUrl = DEFAULT_API_BASE_URL,
  snapshotWindowSeconds = 3600,
  realtimeToken = null,
  realtimeTokenExpiresAt = null,
  refreshRealtimeToken,
  onRealtimeTokenRefresh,
  allowClientSideTicketFetch = false,
  disableWebsocket = false,
  eventBufferSize = DEFAULT_EVENT_BUFFER_SIZE,
  onValidationEvent,
}: UnpriceEntitlementsRealtimeProviderProps) {
  const { client } = useUnpriceClient()
  const maxEvents = Math.max(1, Math.floor(eventBufferSize))

  const [activeRealtimeToken, setActiveRealtimeToken] = useState<string | null>(realtimeToken)
  const [activeRealtimeTokenExpiresAt, setActiveRealtimeTokenExpiresAt] = useState<number | null>(
    normalizeEpochSeconds(realtimeTokenExpiresAt)
  )
  const [isRealtimeTokenExpired, setIsRealtimeTokenExpired] = useState<boolean>(() => {
    const normalizedExpiresAt = normalizeEpochSeconds(realtimeTokenExpiresAt)
    if (!realtimeToken || !normalizedExpiresAt) {
      return true
    }
    return normalizedExpiresAt <= Math.floor(Date.now() / 1000)
  })
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("idle")
  const [isRefreshingToken, setIsRefreshingToken] = useState(false)
  const [isRefreshingEntitlements, setIsRefreshingEntitlements] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [metrics, setMetrics] = useState<RealtimeMetrics | null>(null)
  const [entitlements, setEntitlements] = useState<CustomerEntitlement[]>([])
  const [usageByFeature, setUsageByFeature] = useState<Record<string, number>>({})
  const [events, setEvents] = useState<EntitlementRealtimeEvent[]>([])
  const [validationsByFeature, setValidationsByFeature] = useState<
    Record<string, EntitlementValidationEvent>
  >({})
  const [lastValidationEvent, setLastValidationEvent] = useState<EntitlementValidationEvent | null>(
    null
  )

  const isUnmountedRef = useRef(false)
  const partySocketRef = useRef<SocketSender | null>(null)
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const pendingVerifyRequestsRef = useRef<Map<string, PendingVerifyRequest>>(new Map())
  const lastSnapshotRequestedAtRef = useRef(0)
  const hasAutoRefreshFailedRef = useRef(false)
  const activeRealtimeTokenRef = useRef<string | null>(activeRealtimeToken)
  const isRealtimeTokenExpiredRef = useRef(isRealtimeTokenExpired)
  const roomName = useMemo(() => `${runtimeEnv}:${projectId}:${customerId}`, [
    runtimeEnv,
    projectId,
    customerId,
  ])
  const socketHost = useMemo(() => toWebSocketBaseUrl(apiBaseUrl), [apiBaseUrl])
  const realtimeSocketEnabled = Boolean(activeRealtimeToken) && !isRealtimeTokenExpired && !disableWebsocket

  useEffect(() => {
    activeRealtimeTokenRef.current = activeRealtimeToken
  }, [activeRealtimeToken])

  useEffect(() => {
    isRealtimeTokenExpiredRef.current = isRealtimeTokenExpired
  }, [isRealtimeTokenExpired])

  useEffect(() => {
    setActiveRealtimeToken(realtimeToken)
    setActiveRealtimeTokenExpiresAt(normalizeEpochSeconds(realtimeTokenExpiresAt))
    hasAutoRefreshFailedRef.current = false
  }, [realtimeToken, realtimeTokenExpiresAt])

  useEffect(() => {
    hasAutoRefreshFailedRef.current = false
  }, [customerId, projectId])

  const rejectPendingVerifyRequests = useCallback((message: string) => {
    if (pendingVerifyRequestsRef.current.size === 0) {
      return
    }

    const error = new Error(message)
    for (const [requestId, pending] of pendingVerifyRequestsRef.current.entries()) {
      clearTimeout(pending.timeoutId)
      pending.reject(error)
      pendingVerifyRequestsRef.current.delete(requestId)
    }
  }, [])

  useEffect(() => {
    setMetrics(null)
    setUsageByFeature({})
    setEvents([])
    setValidationsByFeature({})
    setLastValidationEvent(null)
    rejectPendingVerifyRequests("Realtime context changed")
  }, [customerId, projectId, rejectPendingVerifyRequests])

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
      rejectPendingVerifyRequests("Realtime provider unmounted")
    }
  }, [rejectPendingVerifyRequests])

  const appendRealtimeEvent = useCallback(
    (event: EntitlementRealtimeEvent) => {
      setEvents((previous) => [event, ...previous].slice(0, maxEvents))
    },
    [maxEvents]
  )

  const appendValidationEvent = useCallback(
    (event: EntitlementValidationEvent) => {
      setValidationsByFeature((previous) => ({
        ...previous,
        [event.featureSlug]: event,
      }))
      setLastValidationEvent(event)
      onValidationEvent?.(event)
    },
    [onValidationEvent]
  )

  const requestSnapshot = useCallback(
    (params?: { force?: boolean; socket?: SocketSender | null }) => {
      const force = Boolean(params?.force)
      const socket = params?.socket ?? partySocketRef.current

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return
      }

      if (!activeRealtimeTokenRef.current || isRealtimeTokenExpiredRef.current) {
        return
      }

      const now = Date.now()
      if (!force && now - lastSnapshotRequestedAtRef.current < SNAPSHOT_REQUEST_THROTTLE_MS) {
        return
      }

      lastSnapshotRequestedAtRef.current = now
      socket.send(
        JSON.stringify({
          type: "snapshot_request",
          windowSeconds: snapshotWindowSeconds,
          customerId,
          projectId,
        })
      )
    },
    [customerId, projectId, snapshotWindowSeconds]
  )

  const refreshRealtimeTokenInternal = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current
    }

    const task = (async () => {
      setIsRefreshingToken(true)
      try {
        let nextTokenPayload: RealtimeTokenPayload

        if (refreshRealtimeToken) {
          nextTokenPayload = await refreshRealtimeToken({ customerId, projectId })
        } else if (allowClientSideTicketFetch) {
          const response = await client.analytics.getRealtimeTicket({ customerId, projectId })
          if (response.error || !response.result) {
            throw new Error(response.error?.message ?? "Failed to refresh realtime token")
          }

          nextTokenPayload = {
            ticket: response.result.ticket,
            expiresAt: response.result.expiresAt,
          }
        } else {
          throw new Error(
            "No realtime token refresh strategy configured. Pass refreshRealtimeToken or enable allowClientSideTicketFetch."
          )
        }

        const nextExpiresAt = normalizeEpochSeconds(nextTokenPayload.expiresAt)
        if (isUnmountedRef.current) {
          return
        }

        hasAutoRefreshFailedRef.current = false
        setActiveRealtimeToken(nextTokenPayload.ticket)
        setActiveRealtimeTokenExpiresAt(nextExpiresAt)
        setIsRealtimeTokenExpired(!nextExpiresAt || nextExpiresAt <= Math.floor(Date.now() / 1000))
        setError(null)
        onRealtimeTokenRefresh?.({
          ticket: nextTokenPayload.ticket,
          expiresAt: nextExpiresAt,
        })
      } catch (refreshError) {
        hasAutoRefreshFailedRef.current = true
        if (isUnmountedRef.current) {
          return
        }
        setError(toError(refreshError, "Failed to refresh realtime token"))
      } finally {
        if (!isUnmountedRef.current) {
          setIsRefreshingToken(false)
        }
      }
    })()

    refreshPromiseRef.current = task.finally(() => {
      refreshPromiseRef.current = null
    })
    return refreshPromiseRef.current
  }, [
    allowClientSideTicketFetch,
    client,
    customerId,
    onRealtimeTokenRefresh,
    projectId,
    refreshRealtimeToken,
  ])

  const refreshEntitlements = useCallback(async () => {
    setIsRefreshingEntitlements(true)
    try {
      const response = await client.customers.getEntitlements({
        customerId,
        projectId,
      })

      if (response.error) {
        throw new Error(response.error.message)
      }

      if (!isUnmountedRef.current) {
        setEntitlements(response.result ?? [])
        setError(null)
      }
    } catch (entitlementError) {
      if (!isUnmountedRef.current) {
        setError(toError(entitlementError, "Failed to load customer entitlements"))
      }
    } finally {
      if (!isUnmountedRef.current) {
        setIsRefreshingEntitlements(false)
      }
    }
  }, [client, customerId, projectId])

  const handleVerifyResult = useCallback(
    (params: {
      featureSlug: string
      result: VerifyEntitlementResult
      source: EventSource
    }) => {
      const now = Date.now()
      const { featureSlug, result, source } = params

      appendValidationEvent({
        at: now,
        featureSlug,
        allowed: result.allowed,
        deniedReason: result.deniedReason,
        usage: result.usage,
        limit: result.limit,
        message: result.message,
        source,
      })
      appendRealtimeEvent({
        at: now,
        type: "verify",
        featureSlug,
        success: result.allowed,
        deniedReason: result.deniedReason,
        usage: result.usage,
        limit: result.limit,
        latencyMs: result.latency,
        source,
      })

      if (typeof result.usage === "number") {
        const usage = result.usage
        setUsageByFeature((previous) => ({
          ...previous,
          [featureSlug]: usage,
        }))
      }
    },
    [appendRealtimeEvent, appendValidationEvent]
  )

  const handleSocketMessage = useCallback(
    (data: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }

      if (!parsed || typeof parsed !== "object") {
        return
      }

      const payload = parsed as Record<string, unknown>
      const type = readString(payload, "type")

      if (type === "snapshot") {
        const nextMetrics = payload.metrics
        if (nextMetrics && typeof nextMetrics === "object") {
          setMetrics(nextMetrics as RealtimeMetrics)
        }

        const usagePayload = payload.usageByFeature
        if (usagePayload && typeof usagePayload === "object") {
          const nextUsageByFeature: Record<string, number> = {}
          for (const [featureSlug, value] of Object.entries(usagePayload)) {
            if (typeof value === "number") {
              nextUsageByFeature[featureSlug] = value
            }
          }
          setUsageByFeature((previous) => ({
            ...previous,
            ...nextUsageByFeature,
          }))
        }
        return
      }

      if (type === "snapshot_error") {
        const message = readString(payload, "message")
        if (message?.toLowerCase().includes("expired")) {
          setIsRealtimeTokenExpired(true)
        }
        return
      }

      if (type === "verify_result" || type === "verify_error") {
        const requestId = readString(payload, "requestId")
        if (!requestId) {
          return
        }

        const pending = pendingVerifyRequestsRef.current.get(requestId)
        if (!pending) {
          return
        }

        clearTimeout(pending.timeoutId)
        pendingVerifyRequestsRef.current.delete(requestId)

        if (type === "verify_error") {
          const message = readString(payload, "message") ?? "Verification failed"
          pending.reject(new Error(message))
          return
        }

        const rawResult = payload.result
        if (!rawResult || typeof rawResult !== "object") {
          pending.reject(new Error("Invalid verification response payload"))
          return
        }

        const result = rawResult as VerifyEntitlementResult
        if (typeof result.allowed !== "boolean") {
          pending.reject(new Error("Invalid verification response"))
          return
        }

        pending.resolve(result)
        return
      }

      if (type !== "verify" && type !== "reportUsage") {
        return
      }

      const payloadCustomerId = readString(payload, "customerId")
      if (payloadCustomerId && payloadCustomerId !== customerId) {
        return
      }

      const featureSlug = readString(payload, "featureSlug")
      const success = readBoolean(payload, "success")
      if (!featureSlug || typeof success !== "boolean") {
        return
      }

      const usage = readNumber(payload, "usage")
      const limit = readNumber(payload, "limit")
      const deniedReason = readString(payload, "deniedReason") as
        | VerifyEntitlementResult["deniedReason"]
        | undefined
      const latencyMs = readNumber(payload, "latencyMs")
      const now = Date.now()

      appendRealtimeEvent({
        at: now,
        type,
        featureSlug,
        success,
        usage,
        limit,
        deniedReason,
        latencyMs,
        source: "socket",
      })

      if (typeof usage === "number") {
        setUsageByFeature((previous) => ({
          ...previous,
          [featureSlug]: usage,
        }))
      }

      if (type === "verify") {
        appendValidationEvent({
          at: now,
          featureSlug,
          allowed: success,
          deniedReason,
          usage,
          limit,
          source: "socket",
        })
      }

      requestSnapshot()
    },
    [appendRealtimeEvent, appendValidationEvent, customerId, requestSnapshot]
  )

  const validateEntitlement = useCallback(
    async (input: VerifyEntitlementInput) => {
      const resolvedCustomerId = input.customerId ?? customerId

      if (!resolvedCustomerId) {
        throw new Error("customerId is required to validate entitlements")
      }

      if (resolvedCustomerId !== customerId) {
        throw new Error("validateEntitlement customerId must match the provider customerId")
      }

      if (disableWebsocket) {
        throw new Error("Websocket verification is disabled")
      }

      if (!partySocketRef.current || partySocketRef.current.readyState !== WebSocket.OPEN) {
        if (isRealtimeTokenExpiredRef.current) {
          await refreshRealtimeTokenInternal()
        }
      }

      const socket = partySocketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Realtime websocket is not connected")
      }

      const requestId = createVerifyRequestId()
      const payload = {
        type: "verify_request",
        requestId,
        customerId: resolvedCustomerId,
        projectId,
        featureSlug: input.featureSlug,
        usage: input.usage,
        action: input.action,
        metadata: input.metadata,
      }

      const result = await new Promise<VerifyEntitlementResult>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingVerifyRequestsRef.current.delete(requestId)
          reject(new Error("Realtime verification timed out"))
        }, VERIFY_REQUEST_TIMEOUT_MS)

        pendingVerifyRequestsRef.current.set(requestId, {
          resolve,
          reject,
          timeoutId,
        })

        try {
          socket.send(JSON.stringify(payload))
        } catch (sendError) {
          clearTimeout(timeoutId)
          pendingVerifyRequestsRef.current.delete(requestId)
          reject(toError(sendError, "Failed to send realtime verification request"))
        }
      })

      handleVerifyResult({
        featureSlug: input.featureSlug,
        result,
        source: "hook",
      })

      setError(null)
      requestSnapshot({ force: true, socket })
      return result
    },
    [
      customerId,
      disableWebsocket,
      handleVerifyResult,
      projectId,
      refreshRealtimeTokenInternal,
      requestSnapshot,
    ]
  )

  useEffect(() => {
    void refreshEntitlements()
  }, [refreshEntitlements])

  useEffect(() => {
    if (!activeRealtimeToken || !activeRealtimeTokenExpiresAt) {
      setIsRealtimeTokenExpired(true)
      return
    }

    const now = Math.floor(Date.now() / 1000)
    if (activeRealtimeTokenExpiresAt <= now) {
      setIsRealtimeTokenExpired(true)
      return
    }

    setIsRealtimeTokenExpired(false)

    const expiresInMs = Math.max(0, activeRealtimeTokenExpiresAt * 1000 - Date.now())
    const expiryTimer = setTimeout(() => {
      setIsRealtimeTokenExpired(true)
    }, expiresInMs)

    const canAutoRefreshToken = Boolean(refreshRealtimeToken) || allowClientSideTicketFetch
    const refreshInMs = Math.max(
      0,
      activeRealtimeTokenExpiresAt * 1000 - Date.now() - TOKEN_REFRESH_LEAD_SECONDS * 1000
    )

    const refreshTimer =
      canAutoRefreshToken && refreshInMs > 0
        ? setTimeout(() => {
            void refreshRealtimeTokenInternal()
          }, refreshInMs)
        : null

    return () => {
      clearTimeout(expiryTimer)
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
    }
  }, [
    activeRealtimeToken,
    activeRealtimeTokenExpiresAt,
    allowClientSideTicketFetch,
    refreshRealtimeToken,
    refreshRealtimeTokenInternal,
  ])

  useEffect(() => {
    const canAutoRefreshToken = Boolean(refreshRealtimeToken) || allowClientSideTicketFetch

    if (!canAutoRefreshToken || disableWebsocket) {
      return
    }

    if (hasAutoRefreshFailedRef.current) {
      return
    }

    if (activeRealtimeToken && !isRealtimeTokenExpired) {
      return
    }

    void refreshRealtimeTokenInternal()
  }, [
    activeRealtimeToken,
    allowClientSideTicketFetch,
    disableWebsocket,
    isRealtimeTokenExpired,
    refreshRealtimeToken,
    refreshRealtimeTokenInternal,
  ])

  const socket = usePartySocket({
    enabled: realtimeSocketEnabled,
    host: socketHost,
    room: roomName,
    prefix: "broadcast",
    party: "usagelimit",
    query: {
      ticket: activeRealtimeToken ?? "",
    },
    onOpen: (event) => {
      if (isRealtimeTokenExpiredRef.current) {
        return
      }
      setSocketStatus("open")
      requestSnapshot({
        force: true,
        socket: event.currentTarget as unknown as SocketSender | null,
      })
    },
    onMessage: (event) => {
      handleSocketMessage(event.data as string)
    },
    onClose: (event) => {
      setSocketStatus("closed")
      const reason = event.reason.toLowerCase()
      if (reason.includes("expired") || event.code === 4001 || event.code === 4401) {
        setIsRealtimeTokenExpired(true)
      }
      rejectPendingVerifyRequests("Realtime websocket disconnected")
    },
    onError: () => {
      setSocketStatus("error")
    },
  })

  useEffect(() => {
    if (!realtimeSocketEnabled) {
      partySocketRef.current = null
      setSocketStatus("idle")
      rejectPendingVerifyRequests("Realtime websocket disabled")
      return
    }

    partySocketRef.current = socket as unknown as SocketSender
    setSocketStatus((currentStatus) => (currentStatus === "open" ? currentStatus : "connecting"))
    requestSnapshot({
      force: true,
      socket: socket as unknown as SocketSender,
    })
  }, [
    realtimeSocketEnabled,
    rejectPendingVerifyRequests,
    requestSnapshot,
    socket,
  ])

  const entitlementSlugs = useMemo(() => {
    return new Set(entitlements.map((entitlement) => entitlement.featureSlug))
  }, [entitlements])

  const entitlementByFeatureSlug = useMemo(() => {
    const map = new Map<string, CustomerEntitlement>()
    for (const entitlement of entitlements) {
      map.set(entitlement.featureSlug, entitlement)
    }
    return map
  }, [entitlements])

  const value = useMemo<EntitlementsRealtimeContextValue>(
    () => ({
      customerId,
      projectId,
      entitlements,
      entitlementSlugs,
      entitlementByFeatureSlug,
      usageByFeature,
      metrics,
      events,
      validationsByFeature,
      lastValidationEvent,
      socketStatus,
      isConnected: socketStatus === "open",
      isRefreshingToken,
      isRefreshingEntitlements,
      error,
      refreshEntitlements,
      refreshRealtimeToken: refreshRealtimeTokenInternal,
      validateEntitlement,
    }),
    [
      customerId,
      entitlementByFeatureSlug,
      entitlements,
      entitlementSlugs,
      error,
      events,
      isRefreshingEntitlements,
      isRefreshingToken,
      lastValidationEvent,
      metrics,
      projectId,
      refreshEntitlements,
      refreshRealtimeTokenInternal,
      socketStatus,
      usageByFeature,
      validateEntitlement,
      validationsByFeature,
    ]
  )

  return (
    <EntitlementsRealtimeContext.Provider value={value}>
      {children}
    </EntitlementsRealtimeContext.Provider>
  )
}

function useEntitlementsRealtimeContext() {
  const context = useContext(EntitlementsRealtimeContext)
  if (!context) {
    throw new Error(
      "useEntitlementsRealtimeContext must be used inside UnpriceEntitlementsRealtimeProvider"
    )
  }
  return context
}

export function useUnpriceEntitlementsRealtime() {
  return useEntitlementsRealtimeContext()
}

export function useValidateEntitlement() {
  const { validateEntitlement, lastValidationEvent } = useEntitlementsRealtimeContext()
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<Error | null>(null)

  const validate = useCallback(
    async (input: VerifyEntitlementInput) => {
      setPendingCount((count) => count + 1)
      setError(null)
      try {
        return await validateEntitlement(input)
      } catch (validationError) {
        const normalizedError = toError(validationError, "Failed to validate entitlement")
        setError(normalizedError)
        throw normalizedError
      } finally {
        setPendingCount((count) => Math.max(0, count - 1))
      }
    },
    [validateEntitlement]
  )

  return {
    validate,
    isValidating: pendingCount > 0,
    error,
    lastValidationEvent,
  }
}

export function useEntitlement(featureSlug: string): UseEntitlementResult {
  const {
    entitlementByFeatureSlug,
    entitlementSlugs,
    usageByFeature,
    validationsByFeature,
    validateEntitlement,
  } = useEntitlementsRealtimeContext()

  const validate = useCallback(
    async (input: Omit<VerifyEntitlementInput, "featureSlug"> = {}) => {
      return await validateEntitlement({
        ...input,
        featureSlug,
      })
    },
    [featureSlug, validateEntitlement]
  )

  const entitlement = entitlementByFeatureSlug.get(featureSlug) ?? null
  const usage = typeof usageByFeature[featureSlug] === "number" ? usageByFeature[featureSlug] : null
  const lastValidation = validationsByFeature[featureSlug] ?? null
  const isEntitled = entitlementSlugs.has(featureSlug)
  const isAllowed = lastValidation?.allowed ?? isEntitled

  return useMemo(
    () => ({
      featureSlug,
      entitlement,
      isEntitled,
      isAllowed,
      shouldRenderPaywall: !isAllowed,
      usage,
      lastValidation,
      validate,
    }),
    [entitlement, featureSlug, isAllowed, isEntitled, lastValidation, usage, validate]
  )
}

export function EntitlementRealtimeFeature(props: {
  featureSlug: string
  children: (value: UseEntitlementResult) => ReactNode
}) {
  const value = useEntitlement(props.featureSlug)
  return <>{props.children(value)}</>
}

export function EntitlementValidationListener(props: {
  onValidation: (event: EntitlementValidationEvent) => void
  onlyDenied?: boolean
}) {
  const { onValidation, onlyDenied = false } = props
  const { lastValidationEvent } = useEntitlementsRealtimeContext()
  const lastNotifiedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!lastValidationEvent) {
      return
    }

    if (onlyDenied && lastValidationEvent.allowed) {
      return
    }

    const key = `${lastValidationEvent.featureSlug}:${lastValidationEvent.at}:${lastValidationEvent.source}`
    if (lastNotifiedRef.current === key) {
      return
    }

    lastNotifiedRef.current = key
    onValidation(lastValidationEvent)
  }, [lastValidationEvent, onValidation, onlyDenied])

  return null
}
