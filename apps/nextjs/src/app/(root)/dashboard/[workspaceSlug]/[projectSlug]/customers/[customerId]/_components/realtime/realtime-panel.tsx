"use client"

import { API_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { usePartySocket } from "partysocket/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { RealtimeIntervalFilter } from "~/components/analytics/realtime-interval-filter"
import { useRealtimeIntervalFilter } from "~/hooks/use-filter"

type Metrics = {
  usageCount: number
  verificationCount: number
  totalUsage: number
  allowedCount: number
  deniedCount: number
  bucketSizeSeconds: number
  featureStats: Array<{
    featureSlug: string
    usageCount: number
    verificationCount: number
    totalUsage: number
  }>
  usageSeries: Array<{
    bucketStart: number
    usageCount: number
    totalUsage: number
  }>
  verificationSeries: Array<{
    bucketStart: number
    verificationCount: number
    allowedCount: number
    deniedCount: number
  }>
  oldestTimestamp: number | null
  newestTimestamp: number | null
}

type RealtimeEvent = {
  at: number
  featureSlug: string
  type: "verify" | "reportUsage"
  success: boolean
  usage?: number
  limit?: number
  deniedReason?: string
}

const usageChartConfig = {
  totalUsage: { label: "Usage", color: "var(--chart-4)" },
} satisfies ChartConfig

const verificationChartConfig = {
  allowedCount: { label: "Allowed", color: "var(--chart-4)" },
  deniedCount: { label: "Denied", color: "var(--chart-1)" },
} satisfies ChartConfig

export function RealtimePanel(props: {
  customerId: string
  projectId: string
  sessionToken: string
  runtimeEnv: string
}) {
  const { customerId, projectId, sessionToken, runtimeEnv } = props
  const [windowSeconds] = useRealtimeIntervalFilter()
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [events, setEvents] = useState<RealtimeEvent[]>([])
  const lastSnapshotRequestedAtRef = useRef(0)

  const roomName = `${runtimeEnv}:${projectId}:${customerId}`

  const socket = usePartySocket({
    host: API_DOMAIN.replace("https://", "wss://").replace("http://", "ws://"),
    room: roomName,
    prefix: "broadcast",
    party: "usagelimit",
    query: { sessionToken },
    onMessage: (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | {
              type: "snapshot"
              metrics: Metrics
            }
          | {
              type?: "verify" | "reportUsage"
              customerId: string
              featureSlug: string
              success: boolean
              usage?: number
              limit?: number
              deniedReason?: string
            }

        if (payload && "type" in payload && payload.type === "snapshot" && "metrics" in payload) {
          setMetrics(payload.metrics)
          return
        }

        if (!payload || payload.customerId !== customerId) {
          return
        }

        const eventType = payload.type
        if (eventType !== "verify" && eventType !== "reportUsage") {
          return
        }

        setEvents((prev) => [
          {
            at: Date.now(),
            featureSlug: payload.featureSlug,
            type: eventType,
            success: payload.success,
            usage: payload.usage,
            limit: payload.limit,
            deniedReason: payload.deniedReason,
          },
          ...prev.slice(0, 29),
        ])

        if (socket?.readyState === WebSocket.OPEN) {
          const now = Date.now()
          if (now - lastSnapshotRequestedAtRef.current >= 1500) {
            lastSnapshotRequestedAtRef.current = now
            socket.send(
              JSON.stringify({
                type: "snapshot_request",
                windowSeconds,
              })
            )
          }
        }
      } catch {
        return
      }
    },
  })

  useEffect(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      lastSnapshotRequestedAtRef.current = Date.now()
      socket.send(
        JSON.stringify({
          type: "snapshot_request",
          windowSeconds,
        })
      )
    }
  }, [socket, windowSeconds])

  const usageSeriesRows = useMemo(() => {
    return (metrics?.usageSeries ?? []).map((bucket) => ({
      bucketStart: bucket.bucketStart,
      time: new Date(bucket.bucketStart).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      usageCount: bucket.usageCount,
      totalUsage: bucket.totalUsage,
    }))
  }, [metrics?.usageSeries])

  const verificationSeriesRows = useMemo(() => {
    return (metrics?.verificationSeries ?? []).map((bucket) => ({
      bucketStart: bucket.bucketStart,
      time: new Date(bucket.bucketStart).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      verificationCount: bucket.verificationCount,
      allowedCount: bucket.allowedCount,
      deniedCount: bucket.deniedCount,
    }))
  }, [metrics?.verificationSeries])

  const successRate = useMemo(() => {
    if (!metrics || metrics.verificationCount === 0) {
      return null
    }

    return Math.min(100, Math.max(0, (metrics.allowedCount / metrics.verificationCount) * 100))
  }, [metrics?.verificationCount, metrics?.allowedCount])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Usage and verification history</h3>
        <RealtimeIntervalFilter className="w-60" />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Allowed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-semibold text-2xl">{metrics?.allowedCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Denied</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-semibold text-2xl">{metrics?.deniedCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Success rate</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-semibold text-2xl">
              {successRate === null ? "—" : `${successRate.toFixed(1)}%`}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Usage events</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-semibold text-2xl">{metrics?.usageCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Verifications</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-semibold text-2xl">{metrics?.verificationCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Total usage</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-semibold text-2xl">{metrics?.totalUsage ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Usage history</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={usageChartConfig} className="h-[260px] w-full">
              <AreaChart data={usageSeriesRows}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={20} />
                <YAxis tickLine={false} axisLine={false} width={48} />
                <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                <Area
                  type="monotone"
                  dataKey="totalUsage"
                  stroke="var(--color-totalUsage)"
                  fill="var(--color-totalUsage)"
                  fillOpacity={0.22}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Verification history</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={verificationChartConfig} className="h-[260px] w-full">
              <BarChart data={verificationSeriesRows}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={20} />
                <YAxis tickLine={false} axisLine={false} width={48} />
                <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                <Bar
                  dataKey="allowedCount"
                  stackId="verifications"
                  fill="var(--color-allowedCount)"
                />
                <Bar
                  dataKey="deniedCount"
                  stackId="verifications"
                  fill="var(--color-deniedCount)"
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Live events</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[280px]">
            <div className="space-y-2">
              {events.length === 0 && (
                <p className="text-muted-foreground text-sm">No live events yet.</p>
              )}
              {events.map((event) => (
                <div
                  key={`${event.at}-${event.featureSlug}-${event.type}`}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={event.success ? "default" : "destructive"}>{event.type}</Badge>
                    <span className="font-medium text-sm">{event.featureSlug}</span>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {new Date(event.at).toLocaleTimeString()}{" "}
                    {event.deniedReason ? `- ${event.deniedReason}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
