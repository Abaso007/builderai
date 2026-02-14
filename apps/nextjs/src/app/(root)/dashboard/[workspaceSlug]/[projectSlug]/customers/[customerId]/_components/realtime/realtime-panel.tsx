"use client"

import { API_DOMAIN } from "@unprice/config"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { AnimatePresence, motion } from "framer-motion"
import {
  Activity,
  BarChart2,
  CircleHelp,
  Clock,
  Settings,
  Shield,
  ShieldCheck,
  Zap,
} from "lucide-react"
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

type PlanVersionFeature =
  RouterOutputs["planVersions"]["getById"]["planVersion"]["planFeatures"][number]

type CycleFeatureUsageRow = {
  featureSlug: string
  currentUsage: number
  limitType: "hard" | "soft" | "none"
  featureType: "flat" | "tiered" | "usage" | "package"
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

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat([], {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value)
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
  entitlementSlugs?: string[]
  cycleFeatureUsageRows?: CycleFeatureUsageRow[]
  currentPhaseBillingPeriod?: string | null
  planVersionFeatures?: PlanVersionFeature[]
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
    entitlementSlugs = [],
    cycleFeatureUsageRows = [],
    currentPhaseBillingPeriod,
    planVersionFeatures = [],
  } = props
  const [windowSeconds] = useRealtimeIntervalFilter()
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [events, setEvents] = useState<RealtimeEvent[]>([])
  const [browserTimezone, setBrowserTimezone] = useState<string | null>(null)
  const lastSnapshotRequestedAtRef = useRef(0)

  useEffect(() => {
    const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    setBrowserTimezone(resolvedTimeZone || null)
  }, [])

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

  const featureStatsBySlug = useMemo(() => {
    return new Map((metrics?.featureStats ?? []).map((feature) => [feature.featureSlug, feature]))
  }, [metrics?.featureStats])

  const planVersionFeaturesBySlug = useMemo(() => {
    return new Map(planVersionFeatures.map((feature) => [feature.feature.slug, feature]))
  }, [planVersionFeatures])

  const cycleFeatureUsageBySlug = useMemo(() => {
    return new Map(cycleFeatureUsageRows.map((feature) => [feature.featureSlug, feature]))
  }, [cycleFeatureUsageRows])

  const entitlementRows = useMemo(() => {
    const uniqueSlugs = Array.from(
      new Set(entitlementSlugs.filter((featureSlug) => featureSlug.trim().length > 0))
    )

    return uniqueSlugs.map((featureSlug) => {
      const featureStats = featureStatsBySlug.get(featureSlug)
      const planVersionFeature = planVersionFeaturesBySlug.get(featureSlug)
      const cycleFeatureUsage = cycleFeatureUsageBySlug.get(featureSlug)

      return {
        featureSlug,
        usageCount: featureStats?.usageCount ?? 0,
        verificationCount: featureStats?.verificationCount ?? 0,
        totalUsage: featureStats?.totalUsage ?? 0,
        cycleUsage: cycleFeatureUsage?.currentUsage ?? null,
        cycleLimitType: cycleFeatureUsage?.limitType,
        cycleFeatureType: cycleFeatureUsage?.featureType,
        limit: planVersionFeature?.limit ?? null,
        planVersionFeature,
      }
    })
  }, [entitlementSlugs, featureStatsBySlug, planVersionFeaturesBySlug, cycleFeatureUsageBySlug])

  const maxVisibleEntitlementUsage = useMemo(() => {
    return entitlementRows.reduce((maxUsage, entitlement) => {
      return Math.max(maxUsage, entitlement.cycleUsage ?? entitlement.totalUsage)
    }, 0)
  }, [entitlementRows])

  const formatDateForTimezone = (value: number, timeZone?: string | null) => {
    const date = new Date(value)

    try {
      return new Intl.DateTimeFormat([], {
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timeZone ?? undefined,
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

  const cyclePeriodLabel = useMemo(() => {
    if (!currentCycleStartAt) {
      return "No active cycle"
    }

    if (!currentCycleEndAt) {
      return `${formatDateForTimezone(currentCycleStartAt, cycleTimezone)} → Ongoing`
    }

    return `${formatDateForTimezone(currentCycleStartAt, cycleTimezone)} → ${formatDateForTimezone(currentCycleEndAt, cycleTimezone)}`
  }, [currentCycleStartAt, currentCycleEndAt, cycleTimezone])

  const browserCyclePeriodLabel = useMemo(() => {
    if (!currentCycleStartAt || !browserTimezone) {
      return null
    }

    if (!currentCycleEndAt) {
      return `${formatDateForTimezone(currentCycleStartAt, browserTimezone)} → Ongoing`
    }

    return `${formatDateForTimezone(currentCycleStartAt, browserTimezone)} → ${formatDateForTimezone(currentCycleEndAt, browserTimezone)}`
  }, [currentCycleStartAt, currentCycleEndAt, browserTimezone])

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
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground text-xs">Current plan</p>
              <p className="font-semibold text-base">{currentPlanSlug ?? "No active plan"}</p>
            </div>
            <div>
              <p className="flex items-center gap-1 text-muted-foreground text-xs">
                Current billing period
                {browserCyclePeriodLabel && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="Show billing period in browser timezone"
                      >
                        <CircleHelp className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[320px] text-xs">
                      <p>{browserCyclePeriodLabel}</p>
                      {browserTimezone && (
                        <p className="mt-1 text-muted-foreground">
                          Browser timezone: {browserTimezone}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                )}
              </p>
              <div className="flex items-center pt-1.5">
                <p className="font-medium text-xs">{cyclePeriodLabel}</p>
              </div>
              {cycleTimezone && <p className="text-muted-foreground text-xs">{cycleTimezone}</p>}
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Billing cycle</p>
              <p className="font-medium text-sm">{currentPhaseBillingPeriod ?? "Unavailable"}</p>
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

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Card className="border-muted/60 lg:w-[32%] lg:flex-none">
          <CardHeader>
            <CardTitle className="text-base">Entitlements</CardTitle>
            <CardDescription>Usage and verification by entitlement</CardDescription>
          </CardHeader>
          <CardContent>
            {entitlementRows.length === 0 ? (
              <div className="flex h-[200px] items-center justify-center text-muted-foreground text-sm">
                No active entitlements
              </div>
            ) : (
              <div className="space-y-4">
                {entitlementRows.map((entitlement, index) => {
                  const featureType =
                    entitlement.planVersionFeature?.featureType ?? entitlement.cycleFeatureType
                  const isFlatFeature = featureType === "flat"
                  const limitValue =
                    typeof entitlement.limit === "number" && entitlement.limit > 0
                      ? entitlement.limit
                      : null
                  const hasLimit = limitValue !== null
                  const usageValue = entitlement.cycleUsage ?? entitlement.totalUsage
                  const overageStrategy =
                    entitlement.planVersionFeature?.metadata?.overageStrategy ?? "none"
                  const effectiveLimitType =
                    entitlement.cycleLimitType ??
                    (hasLimit ? (overageStrategy === "none" ? "hard" : "soft") : "none")
                  const allowsOverage = effectiveLimitType !== "hard"

                  let usageReference = 1
                  if (limitValue !== null) {
                    usageReference = limitValue
                  } else if (maxVisibleEntitlementUsage > 0) {
                    usageReference = maxVisibleEntitlementUsage
                  }

                  const rawUsagePercent = isFlatFeature ? 100 : (usageValue / usageReference) * 100
                  const usageProgressPercent = isFlatFeature
                    ? 100
                    : Math.min(100, Math.max(rawUsagePercent, 0))
                  const overagePercent =
                    !isFlatFeature && hasLimit && allowsOverage
                      ? Math.min(100, Math.max(rawUsagePercent - 100, 0))
                      : 0

                  const usageStatusText = isFlatFeature
                    ? "Flat feature"
                    : hasLimit
                      ? `${rawUsagePercent.toFixed(1)}% of limit`
                      : "No limit"

                  const usageBarColor = isFlatFeature
                    ? "hsl(var(--muted-foreground) / 0.35)"
                    : hasLimit && rawUsagePercent > 100
                      ? allowsOverage
                        ? "hsl(var(--chart-5))"
                        : "hsl(var(--destructive))"
                      : `var(--chart-${(index % 5) + 1})`

                  const usageSummaryText = isFlatFeature
                    ? `Flat feature · ${formatCompactNumber(entitlement.verificationCount)} verifications`
                    : `${formatCompactNumber(usageValue)} used · ${usageStatusText}`

                  return (
                    <div key={entitlement.featureSlug} className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">{entitlement.featureSlug}</span>
                          {entitlement.planVersionFeature && (
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button
                                  type="button"
                                  variant="link"
                                  size="icon"
                                  className="size-4 text-muted-foreground hover:text-foreground"
                                >
                                  <Settings className="size-3.5" />
                                  <span className="sr-only">View entitlement configuration</span>
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[620px]">
                                <DialogHeader>
                                  <DialogTitle>
                                    Entitlement: {entitlement.planVersionFeature.feature.title}
                                  </DialogTitle>
                                  <DialogDescription>
                                    {entitlement.planVersionFeature.feature.description ??
                                      "Plan version configuration for this entitlement."}
                                  </DialogDescription>
                                </DialogHeader>

                                <div className="space-y-4">
                                  <div className="grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                      <p className="text-muted-foreground text-xs">Feature type</p>
                                      <p className="font-medium">
                                        {entitlement.planVersionFeature.featureType}
                                      </p>
                                    </div>
                                    <div>
                                      <p className="text-muted-foreground text-xs">Limit</p>
                                      <p className="font-medium">
                                        {typeof entitlement.planVersionFeature.limit === "number"
                                          ? formatCompactNumber(
                                              entitlement.planVersionFeature.limit
                                            )
                                          : "No limit"}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="space-y-1">
                                    <p className="text-muted-foreground text-xs">
                                      Configuration JSON
                                    </p>
                                    <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
                                      {JSON.stringify(
                                        entitlement.planVersionFeature.config,
                                        null,
                                        2
                                      )}
                                    </pre>
                                  </div>

                                  {entitlement.planVersionFeature.resetConfig && (
                                    <div className="space-y-1">
                                      <p className="text-muted-foreground text-xs">Reset config</p>
                                      <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
                                        {JSON.stringify(
                                          entitlement.planVersionFeature.resetConfig,
                                          null,
                                          2
                                        )}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </DialogContent>
                            </Dialog>
                          )}
                        </div>
                        <span className="text-muted-foreground text-xs">{usageSummaryText}</span>
                      </div>
                      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full"
                          style={{
                            backgroundColor: usageBarColor,
                            width: `${usageProgressPercent}%`,
                          }}
                        />
                        {overagePercent > 0 && (
                          <div
                            className="absolute inset-y-0 right-0 bg-amber-500/40"
                            style={{ width: `${overagePercent}%` }}
                          />
                        )}
                      </div>
                      <div className="flex items-center justify-between text-muted-foreground text-xs">
                        <span>
                          {isFlatFeature
                            ? `flat feature · verifications ${entitlement.verificationCount}`
                            : `usage events ${entitlement.usageCount} · verifications ${entitlement.verificationCount}`}
                        </span>
                        {!isFlatFeature && typeof entitlement.limit === "number" && (
                          <span>limit {formatCompactNumber(entitlement.limit)}</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 border-muted/60 lg:w-[68%]">
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
          <CardContent className="px-4 pt-0 pb-4">
            {events.length === 0 ? (
              <EmptyPlaceholder className="h-[240px] w-auto border border-dashed">
                <EmptyPlaceholder.Icon>
                  <BarChart2 className="h-8 w-8 opacity-30" />
                </EmptyPlaceholder.Icon>
                <EmptyPlaceholder.Title>Waiting for events</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Live events will appear here automatically.
                </EmptyPlaceholder.Description>
              </EmptyPlaceholder>
            ) : (
              <ScrollArea
                className="h-[460px] [&_[data-radix-scroll-area-scrollbar]]:hidden"
                hideScrollBar
              >
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
                        className="flex items-center justify-between border-b px-5 py-3.5 hover:bg-muted/40"
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
