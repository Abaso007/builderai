"use client"

import { API_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { AnimatePresence, motion } from "framer-motion"
import { Activity, BarChart2, CircleHelp, Clock, Shield, ShieldCheck, Zap } from "lucide-react"
import { usePartySocket } from "partysocket/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { RealtimeIntervalFilter } from "~/components/analytics/realtime-interval-filter"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useRealtimeIntervalFilter } from "~/hooks/use-filter"

type Metrics = {
  usageCount: number
  verificationCount: number
  totalUsage: number
  allowedCount: number
  deniedCount: number
  limitExceededCount: number
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
    limitExceededCount: number
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
  latencyMs?: number
  deniedReason?: string
}

const usageChartConfig = {
  totalUsage: { label: "Usage", color: "var(--chart-4)" },
} satisfies ChartConfig

const verificationChartConfig = {
  verificationAllowedCount: { label: "Verify allowed", color: "var(--chart-4)" },
  verificationDeniedPolicyCount: {
    label: "Verify denied (policy)",
    color: "var(--chart-1)",
  },
  usageReportedCount: { label: "Usage reports", color: "var(--chart-2)" },
  usageLimitExceededCount: {
    label: "Verify denied (limit exceeded)",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig

function InfoTooltip({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="More info"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-xs">{content}</TooltipContent>
    </Tooltip>
  )
}

export function RealtimePanel(props: {
  customerId: string
  projectId: string
  sessionToken: string
  runtimeEnv: string
  currentPlanSlug?: string | null
  currentCycleStartAt?: number | null
  currentCycleEndAt?: number | null
  cycleTimezone?: string | null
}) {
  const {
    customerId,
    projectId,
    sessionToken,
    runtimeEnv,
    currentPlanSlug,
    currentCycleStartAt,
    currentCycleEndAt,
    cycleTimezone,
  } = props
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
              latencyMs?: number
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
            latencyMs: payload.latencyMs,
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

  const shouldRollupToFiveMinutes =
    windowSeconds === 60 * 60 && (metrics?.bucketSizeSeconds ?? 60) <= 60

  const chartBucketSizeSeconds = shouldRollupToFiveMinutes
    ? 5 * 60
    : Math.max(metrics?.bucketSizeSeconds ?? 60, 60)

  const usageSeriesRows = useMemo(() => {
    const grouped = new Map<
      number,
      {
        bucketStart: number
        usageCount: number
        totalUsage: number
      }
    >()

    for (const bucket of metrics?.usageSeries ?? []) {
      const groupStart =
        Math.floor(bucket.bucketStart / (chartBucketSizeSeconds * 1000)) *
        chartBucketSizeSeconds *
        1000

      const existing = grouped.get(groupStart)
      if (existing) {
        existing.usageCount += bucket.usageCount
        existing.totalUsage += bucket.totalUsage
        continue
      }

      grouped.set(groupStart, {
        bucketStart: groupStart,
        usageCount: bucket.usageCount,
        totalUsage: bucket.totalUsage,
      })
    }

    return Array.from(grouped.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((bucket) => ({
        ...bucket,
        time: new Date(bucket.bucketStart).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      }))
  }, [metrics?.usageSeries, chartBucketSizeSeconds])

  const verificationSeriesRows = useMemo(() => {
    const seriesByBucket = new Map<
      number,
      {
        bucketStart: number
        verificationAllowedCount: number
        verificationDeniedPolicyCount: number
        usageReportedCount: number
        usageLimitExceededCount: number
      }
    >()

    for (const bucket of metrics?.verificationSeries ?? []) {
      const policyDeniedCount = Math.max(bucket.deniedCount - bucket.limitExceededCount, 0)
      const groupStart =
        Math.floor(bucket.bucketStart / (chartBucketSizeSeconds * 1000)) *
        chartBucketSizeSeconds *
        1000

      const existing = seriesByBucket.get(groupStart)
      if (existing) {
        existing.verificationAllowedCount += bucket.allowedCount
        existing.verificationDeniedPolicyCount += policyDeniedCount
        existing.usageLimitExceededCount += bucket.limitExceededCount
        continue
      }

      seriesByBucket.set(groupStart, {
        bucketStart: groupStart,
        verificationAllowedCount: bucket.allowedCount,
        verificationDeniedPolicyCount: policyDeniedCount,
        usageReportedCount: 0,
        usageLimitExceededCount: bucket.limitExceededCount,
      })
    }

    for (const bucket of metrics?.usageSeries ?? []) {
      const groupStart =
        Math.floor(bucket.bucketStart / (chartBucketSizeSeconds * 1000)) *
        chartBucketSizeSeconds *
        1000

      const existing = seriesByBucket.get(groupStart)
      if (existing) {
        existing.usageReportedCount += bucket.usageCount
        continue
      }

      seriesByBucket.set(groupStart, {
        bucketStart: groupStart,
        verificationAllowedCount: 0,
        verificationDeniedPolicyCount: 0,
        usageReportedCount: bucket.usageCount,
        usageLimitExceededCount: 0,
      })
    }

    return Array.from(seriesByBucket.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((bucket) => ({
        ...bucket,
        time: new Date(bucket.bucketStart).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      }))
  }, [metrics?.verificationSeries, metrics?.usageSeries, chartBucketSizeSeconds])

  const successRate = useMemo(() => {
    if (!metrics || metrics.verificationCount === 0) {
      return null
    }

    return Math.min(100, Math.max(0, (metrics.allowedCount / metrics.verificationCount) * 100))
  }, [metrics?.verificationCount, metrics?.allowedCount])

  const topFeatures = useMemo(() => {
    return [...(metrics?.featureStats ?? [])]
      .sort(
        (a, b) =>
          b.usageCount + b.verificationCount - (a.usageCount + a.verificationCount) ||
          b.totalUsage - a.totalUsage
      )
      .slice(0, 5)
  }, [metrics?.featureStats])

  const visibleFeatureActivityTotal = useMemo(() => {
    return topFeatures.reduce(
      (total, feature) => total + feature.usageCount + feature.verificationCount,
      0
    )
  }, [topFeatures])

  const cyclePeriodLabel = useMemo(() => {
    if (!currentCycleStartAt) {
      return "No active cycle"
    }

    const formatCycleDate = (value: number) => {
      const date = new Date(value)

      try {
        return new Intl.DateTimeFormat([], {
          month: "short",
          day: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: cycleTimezone ?? undefined,
        }).format(date)
      } catch {
        return new Intl.DateTimeFormat([], {
          month: "short",
          day: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date)
      }
    }

    if (!currentCycleEndAt) {
      return `${formatCycleDate(currentCycleStartAt)} - Ongoing`
    }

    return `${formatCycleDate(currentCycleStartAt)} - ${formatCycleDate(currentCycleEndAt)}`
  }, [currentCycleStartAt, currentCycleEndAt, cycleTimezone])

  const bucketLabel =
    chartBucketSizeSeconds % 3600 === 0
      ? `${chartBucketSizeSeconds / 3600}h`
      : `${chartBucketSizeSeconds / 60}m`

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 font-semibold text-lg tracking-tight">
            Realtime Activity
            <div className="inline-block">
              <div className="flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs shadow-sm">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="font-medium text-muted-foreground">Live</span>
              </div>
            </div>
          </h3>
          <p className="text-muted-foreground text-sm">
            Live usage and verification metrics for this customer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RealtimeIntervalFilter className="w-[180px]" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_2fr]">
        <Card className="border-muted/60 bg-gradient-to-br from-background to-muted/30">
          <CardHeader className="pb-0" />
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground text-xs">Current plan</p>
              <p className="font-semibold text-base">{currentPlanSlug ?? "No active plan"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Current billing period</p>
              <p className="font-medium text-sm">{cyclePeriodLabel}</p>
              {cycleTimezone && <p className="text-muted-foreground text-xs">{cycleTimezone}</p>}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="font-medium text-sm">Total usage</CardTitle>
                <InfoTooltip content="Sum of usage units reported by `reportUsage` events in the selected interval." />
              </div>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="font-bold text-2xl">
                <NumberTicker value={metrics?.totalUsage ?? 0} />
              </div>
              <p className="text-muted-foreground text-xs">
                Across {metrics?.usageCount ?? 0} events
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="font-medium text-sm">Verifications</CardTitle>
                <InfoTooltip content="Count of `verify` checks. Denied is split into policy denials and limit-exceeded denials." />
              </div>
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="font-bold text-2xl">
                <NumberTicker value={metrics?.verificationCount ?? 0} />
              </div>
              <p className="text-muted-foreground text-xs">
                {metrics?.allowedCount ?? 0} allowed · {metrics?.deniedCount ?? 0} denied ·{" "}
                {metrics?.limitExceededCount ?? 0} exceeded
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="font-medium text-sm">Success rate</CardTitle>
                <InfoTooltip content="Formula: allowed verifications / total verifications * 100." />
              </div>
              <Zap className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="font-bold text-2xl">
                {successRate === null ? (
                  "—"
                ) : (
                  <NumberTicker value={successRate} decimalPlaces={1} />
                )}
                {successRate === null ? "" : "%"}
              </div>
              <p className="text-muted-foreground text-xs">Verification pass ratio</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-muted/60">
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-base">Usage Volume</CardTitle>
              <InfoTooltip content="Timeline of usage units from `reportUsage`. Buckets are grouped for readability when needed." />
            </div>
            <CardDescription>
              Total usage reported over time ({bucketLabel} buckets)
              {shouldRollupToFiveMinutes ? " - grouped from 1m to 5m." : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={usageChartConfig} className="h-[280px] w-full">
              <AreaChart data={usageSeriesRows}>
                <defs>
                  <linearGradient id="fillTotalUsage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-totalUsage)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-totalUsage)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={30}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                  dy={10}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                />
                <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                <Area
                  type="monotone"
                  dataKey="totalUsage"
                  stroke="var(--color-totalUsage)"
                  fill="url(#fillTotalUsage)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="border-muted/60">
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-base">Verification and Usage Outcomes</CardTitle>
              <InfoTooltip content="Verification stack: allowed and policy denied. Usage stack: usage reports and verify denials caused by limit exceeded." />
            </div>
            <CardDescription>
              Verification outcomes are separated from usage reporting ({bucketLabel} buckets)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={verificationChartConfig} className="h-[280px] w-full">
              <BarChart data={verificationSeriesRows}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={30}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                  dy={10}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                />
                <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                <Bar
                  dataKey="verificationAllowedCount"
                  stackId="verifications"
                  fill="var(--color-verificationAllowedCount)"
                  radius={[0, 0, 4, 4]}
                />
                <Bar
                  dataKey="verificationDeniedPolicyCount"
                  stackId="verifications"
                  fill="var(--color-verificationDeniedPolicyCount)"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="usageReportedCount"
                  stackId="usage"
                  fill="var(--color-usageReportedCount)"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="usageLimitExceededCount"
                  stackId="usage"
                  fill="var(--color-usageLimitExceededCount)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
            <div className="mt-2 grid gap-1 text-muted-foreground text-xs">
              <p>Verification stack: verify allowed + verify denied (policy)</p>
              <p>Usage stack: usage reports + verify denied (limit exceeded)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="border-muted/60 lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Top Features</CardTitle>
            <CardDescription>
              Share within top 5 features (usage events + verifications)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {topFeatures.length === 0 ? (
              <div className="flex h-[200px] items-center justify-center text-muted-foreground text-sm">
                No feature activity yet
              </div>
            ) : (
              <div className="space-y-4">
                {topFeatures.map((feature, index) => (
                  <div key={feature.featureSlug} className="space-y-1.5">
                    {(() => {
                      const featureActivity = feature.usageCount + feature.verificationCount
                      const activityShare =
                        visibleFeatureActivityTotal > 0
                          ? (featureActivity / visibleFeatureActivityTotal) * 100
                          : 0

                      return (
                        <>
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium">{feature.featureSlug}</span>
                            <span className="text-muted-foreground text-xs">
                              {featureActivity} activity · {activityShare.toFixed(1)}%
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full"
                              style={{
                                backgroundColor: `var(--chart-${(index % 5) + 1})`,
                                width: `${activityShare}%`,
                              }}
                            />
                          </div>
                          <p className="text-muted-foreground text-xs">
                            usage {feature.usageCount} + verifications {feature.verificationCount}
                          </p>
                        </>
                      )
                    })()}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex flex-col border-muted/60 lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Live Event Stream</CardTitle>
                <CardDescription>Real-time verification and usage logs</CardDescription>
              </div>
              <Badge variant="outline" className="font-mono text-xs">
                {events.length} events
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            {events.length === 0 ? (
              <EmptyPlaceholder className="m-4 h-[240px] w-auto border border-dashed">
                <EmptyPlaceholder.Icon>
                  <BarChart2 className="h-8 w-8 opacity-30" />
                </EmptyPlaceholder.Icon>
                <EmptyPlaceholder.Title>Waiting for events</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Live events will appear here automatically.
                </EmptyPlaceholder.Description>
              </EmptyPlaceholder>
            ) : (
              <ScrollArea className="h-[320px]">
                <AnimatePresence initial={false}>
                  {events.map((event) => {
                    const detailParts: string[] = []

                    if (event.type === "reportUsage") {
                      if (typeof event.usage === "number") {
                        detailParts.push(`usage ${event.usage}`)
                      }
                      if (typeof event.limit === "number") {
                        detailParts.push(`limit ${event.limit}`)
                      }
                    } else {
                      detailParts.push(
                        event.success ? "verification allowed" : "verification denied"
                      )
                    }

                    if (event.deniedReason) {
                      detailParts.push(event.deniedReason)
                    }

                    if (typeof event.latencyMs === "number") {
                      detailParts.push(`${event.latencyMs}ms`)
                    }

                    if (detailParts.length === 0) {
                      detailParts.push("verification check")
                    }

                    return (
                      <motion.div
                        key={`${event.at}-${event.featureSlug}-${event.type}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.18 }}
                        layout="position"
                        className="flex items-center justify-between border-b px-4 py-2.5 hover:bg-muted/40"
                        style={{ borderColor: "hsl(var(--border) / 0.6)" }}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {event.type === "verify" ? (
                            <Shield
                              className={cn(
                                "h-4 w-4",
                                event.success ? "text-muted-foreground" : "text-amber-600"
                              )}
                            />
                          ) : (
                            <Activity className="h-4 w-4 text-muted-foreground" />
                          )}
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-medium text-sm">
                                {event.featureSlug}
                              </span>
                              <span className="text-muted-foreground text-xs">{event.type}</span>
                            </div>
                            <p className="truncate text-muted-foreground text-xs">
                              {detailParts.join(" · ")}
                            </p>
                          </div>
                        </div>
                        <div className="ml-3 flex items-center gap-2 whitespace-nowrap text-muted-foreground text-xs">
                          <Clock className="h-3 w-3" />
                          <span>{new Date(event.at).toLocaleTimeString()}</span>
                        </div>
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
