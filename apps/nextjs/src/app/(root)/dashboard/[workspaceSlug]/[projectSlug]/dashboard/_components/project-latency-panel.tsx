"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { regionsCloudflare } from "@unprice/analytics/utils"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Activity, Gauge, Globe2, Radar } from "lucide-react"
import { useMemo } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"

const latencyTrendConfig = {
  p50_latency: { label: "P50", color: "var(--chart-3)" },
  p95_latency: { label: "P95", color: "var(--chart-5)" },
  p99_latency: { label: "P99", color: "var(--chart-1)" },
} satisfies ChartConfig

const regionHotspotConfig = {
  p99_latency: { label: "P99", color: "var(--chart-1)" },
} satisfies ChartConfig

function formatBucketLabel(input: Date | string, intervalDays: number) {
  const date = new Date(input)

  if (Number.isNaN(date.getTime())) {
    return "--"
  }

  if (intervalDays === 1) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  return date.toLocaleDateString([], { month: "short", day: "2-digit" })
}

function formatRegionLabel(regionCode: string) {
  const code = regionCode.toUpperCase()
  const region = regionsCloudflare[code]

  if (!region) {
    return code
  }

  return `${region.location} (${code})`
}

export function ProjectLatencyPanelSkeleton() {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Project Latency</CardTitle>
        <CardDescription>Loading Tinybird latency analytics...</CardDescription>
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="h-[420px]" isLoading={true}>
          <EmptyPlaceholder.Icon>
            <Radar className="h-8 w-8 opacity-30" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Preparing latency dashboard</EmptyPlaceholder.Title>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

export function ProjectLatencyPanel() {
  const trpc = useTRPC()
  const [intervalFilter] = useIntervalFilter()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const summaryRefetchInterval = isNearRealtime ? 60 * 1000 : (false as const)
  const heavyRefetchInterval = isNearRealtime ? 120 * 1000 : (false as const)

  const {
    data: verificationRegions,
    dataUpdatedAt: regionsUpdatedAt,
    isFetching: isRegionsFetching,
  } = useSuspenseQuery(
    trpc.analytics.getVerificationRegions.queryOptions(
      {
        interval_days: intervalFilter.intervalDays,
      },
      {
        staleTime: isNearRealtime ? 60 * 1000 : 5 * 60 * 1000,
        refetchInterval: heavyRefetchInterval,
        refetchOnWindowFocus: false,
      }
    )
  )

  const {
    data: verifications,
    dataUpdatedAt: verificationsUpdatedAt,
    isFetching: isVerificationsFetching,
  } = useSuspenseQuery(
    trpc.analytics.getVerifications.queryOptions(
      {
        interval_days: intervalFilter.intervalDays,
      },
      {
        staleTime: isNearRealtime ? 60 * 1000 : 5 * 60 * 1000,
        refetchInterval: heavyRefetchInterval,
        refetchOnWindowFocus: false,
      }
    )
  )

  const {
    data: featuresOverview,
    dataUpdatedAt: overviewUpdatedAt,
    isFetching: isOverviewFetching,
  } = useSuspenseQuery(
    trpc.analytics.getFeaturesOverview.queryOptions(
      {
        interval_days: intervalFilter.intervalDays,
      },
      {
        staleTime: isNearRealtime ? 45 * 1000 : 5 * 60 * 1000,
        refetchInterval: summaryRefetchInterval,
        refetchOnWindowFocus: false,
      }
    )
  )

  useQueryInvalidation({
    paramKey: intervalFilter.intervalDays,
    dataUpdatedAt: regionsUpdatedAt,
    isFetching: isRegionsFetching,
    getQueryKey: (param) => [
      ["analytics", "getVerificationRegions"],
      {
        input: {
          interval_days: param,
        },
        type: "query",
      },
    ],
  })

  useQueryInvalidation({
    paramKey: intervalFilter.intervalDays,
    dataUpdatedAt: verificationsUpdatedAt,
    isFetching: isVerificationsFetching,
    getQueryKey: (param) => [
      ["analytics", "getVerifications"],
      {
        input: {
          interval_days: param,
        },
        type: "query",
      },
    ],
  })

  useQueryInvalidation({
    paramKey: intervalFilter.intervalDays,
    dataUpdatedAt: overviewUpdatedAt,
    isFetching: isOverviewFetching,
    getQueryKey: (param) => [
      ["analytics", "getFeaturesOverview"],
      {
        input: {
          interval_days: param,
        },
        type: "query",
      },
    ],
  })

  const regionRows = verificationRegions.verifications ?? []
  const featureRows = verifications.verifications ?? []
  const overviewRows = featuresOverview.data ?? []

  const trendRows = useMemo(() => {
    const byBucket = new Map<
      number,
      {
        bucketStart: number
        checks: number
        p50Weight: number
        p95Weight: number
        p99Max: number
      }
    >()

    for (const row of regionRows) {
      const bucketStart = new Date(row.date).getTime()

      if (Number.isNaN(bucketStart)) {
        continue
      }

      const checks = row.count > 0 ? row.count : 1
      const existing = byBucket.get(bucketStart)

      if (!existing) {
        byBucket.set(bucketStart, {
          bucketStart,
          checks,
          p50Weight: row.p50_latency * checks,
          p95Weight: row.p95_latency * checks,
          p99Max: row.p99_latency,
        })
        continue
      }

      existing.checks += checks
      existing.p50Weight += row.p50_latency * checks
      existing.p95Weight += row.p95_latency * checks
      existing.p99Max = Math.max(existing.p99Max, row.p99_latency)
    }

    return Array.from(byBucket.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((row) => ({
        time: formatBucketLabel(new Date(row.bucketStart), intervalFilter.intervalDays),
        p50_latency: row.p50Weight / row.checks,
        p95_latency: row.p95Weight / row.checks,
        p99_latency: row.p99Max,
      }))
  }, [regionRows, intervalFilter.intervalDays])

  const regionHotspots = useMemo(() => {
    const byRegion = new Map<
      string,
      {
        region: string
        checks: number
        p50Weight: number
        p95Weight: number
        p99Max: number
      }
    >()

    for (const row of regionRows) {
      if (!row.region) {
        continue
      }

      const region = row.region.toUpperCase()
      const checks = row.count > 0 ? row.count : 1
      const existing = byRegion.get(region)

      if (!existing) {
        byRegion.set(region, {
          region,
          checks,
          p50Weight: row.p50_latency * checks,
          p95Weight: row.p95_latency * checks,
          p99Max: row.p99_latency,
        })
        continue
      }

      existing.checks += checks
      existing.p50Weight += row.p50_latency * checks
      existing.p95Weight += row.p95_latency * checks
      existing.p99Max = Math.max(existing.p99Max, row.p99_latency)
    }

    return Array.from(byRegion.values())
      .map((row) => ({
        region: row.region,
        checks: row.checks,
        p50_latency: row.p50Weight / row.checks,
        p95_latency: row.p95Weight / row.checks,
        p99_latency: row.p99Max,
      }))
      .sort((a, b) => b.p99_latency - a.p99_latency || b.checks - a.checks)
  }, [regionRows])

  const featureHotspots = useMemo(() => {
    return [...featureRows]
      .map((row) => ({
        feature_slug: row.feature_slug,
        count: row.count,
        p50_latency: row.p50_latency,
        p95_latency: row.p95_latency,
        p99_latency: row.p99_latency,
      }))
      .sort((a, b) => b.p99_latency - a.p99_latency || b.count - a.count)
      .slice(0, 12)
  }, [featureRows])

  const metrics = useMemo(() => {
    const totalChecks = featureRows.reduce((total, row) => total + row.count, 0)
    const weightedByCount = totalChecks > 0 ? totalChecks : 1

    const p50 =
      featureRows.reduce((total, row) => total + row.p50_latency * Math.max(1, row.count), 0) /
      weightedByCount
    const p95 =
      featureRows.reduce((total, row) => total + row.p95_latency * Math.max(1, row.count), 0) /
      weightedByCount

    const peakP99 = Math.max(
      0,
      ...featureRows.map((row) => row.p99_latency),
      ...trendRows.map((row) => row.p99_latency)
    )

    const latestTrend =
      [...overviewRows].reverse().find((row) => row.latency > 0)?.latency ?? peakP99

    return {
      totalChecks,
      p50,
      p95,
      peakP99,
      latestTrend,
      activeRegions: regionHotspots.length,
    }
  }, [featureRows, trendRows, overviewRows, regionHotspots.length])

  const isEmpty = featureRows.length === 0 && regionRows.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-semibold text-base">Project Latency</h3>
          <p className="text-muted-foreground text-sm">
            Latency telemetry for the {intervalFilter.label}.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="border-muted/60">
          <CardContent className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-muted-foreground text-xs">Latest p99</p>
              <Gauge className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="font-semibold text-xl">
              <NumberTicker value={metrics.latestTrend} decimalPlaces={1} isTime={true} />
            </p>
          </CardContent>
        </Card>

        <Card className="border-muted/60">
          <CardContent className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-muted-foreground text-xs">Interval p95</p>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="font-semibold text-xl">
              <NumberTicker value={metrics.p95} decimalPlaces={1} isTime={true} />
            </p>
          </CardContent>
        </Card>

        <Card className="border-muted/60">
          <CardContent className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-muted-foreground text-xs">Peak p99</p>
              <Radar className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="font-semibold text-xl">
              <NumberTicker value={metrics.peakP99} decimalPlaces={1} isTime={true} />
            </p>
          </CardContent>
        </Card>

        <Card className="border-muted/60">
          <CardContent className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-muted-foreground text-xs">Active regions</p>
              <Globe2 className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="font-semibold text-xl">
              <NumberTicker value={metrics.activeRegions} withFormatter={false} />
            </p>
            <p className="text-muted-foreground text-xs">
              <NumberTicker value={metrics.totalChecks} withFormatter={true} /> checks
            </p>
          </CardContent>
        </Card>
      </div>

      {isEmpty ? (
        <EmptyPlaceholder className="h-[360px] border border-dashed">
          <EmptyPlaceholder.Icon>
            <Radar className="h-8 w-8 opacity-30" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No latency telemetry yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Tinybird will populate this view as project verifications are ingested.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
            <Card className="border-muted/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Latency Trend</CardTitle>
                <CardDescription>Weighted p50/p95 and peak p99 over time</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer
                  config={latencyTrendConfig}
                  className="h-[320px] w-full lg:h-[360px]"
                >
                  <AreaChart data={trendRows}>
                    <defs>
                      <linearGradient id="fillP50" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-p50_latency)" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="var(--color-p50_latency)" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="fillP95" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-p95_latency)" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="var(--color-p95_latency)" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="fillP99" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-p99_latency)" stopOpacity={0.18} />
                        <stop offset="95%" stopColor="var(--color-p99_latency)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      vertical={false}
                      strokeDasharray="3 3"
                      className="stroke-muted"
                    />
                    <XAxis
                      dataKey="time"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={28}
                      tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                      dy={10}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                      tickFormatter={(value) => `${Math.round(value)}ms`}
                    />
                    <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                    <Area
                      type="monotone"
                      dataKey="p50_latency"
                      stroke="var(--color-p50_latency)"
                      fill="url(#fillP50)"
                      strokeWidth={1.8}
                    />
                    <Area
                      type="monotone"
                      dataKey="p95_latency"
                      stroke="var(--color-p95_latency)"
                      fill="url(#fillP95)"
                      strokeWidth={2}
                    />
                    <Area
                      type="monotone"
                      dataKey="p99_latency"
                      stroke="var(--color-p99_latency)"
                      fill="url(#fillP99)"
                      strokeWidth={2.2}
                    />
                  </AreaChart>
                </ChartContainer>
              </CardContent>
            </Card>

            <Card className="border-muted/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Slowest Regions</CardTitle>
                <CardDescription>Top regions by p99 latency</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer
                  config={regionHotspotConfig}
                  className="h-[320px] w-full overflow-hidden lg:h-[360px]"
                >
                  <BarChart
                    data={regionHotspots.slice(0, 6)}
                    layout="vertical"
                    margin={{ top: 2, right: 8, left: 0, bottom: 2 }}
                  >
                    <CartesianGrid horizontal={false} className="stroke-muted" />
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="region"
                      width={46}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          indicator="dot"
                          labelFormatter={(label) => formatRegionLabel(String(label ?? "UNK"))}
                          formatter={(value, name) => {
                            if (typeof value !== "number") {
                              return value
                            }

                            return (
                              <>
                                <span>
                                  {regionHotspotConfig[name as "p99_latency"]?.label ?? name}
                                </span>
                                <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                                  {Math.round(value)}ms
                                </span>
                              </>
                            )
                          }}
                        />
                      }
                    />
                    <Bar
                      dataKey="p99_latency"
                      fill="var(--color-p99_latency)"
                      radius={[0, 4, 4, 0]}
                    >
                      <LabelList
                        dataKey="p99_latency"
                        position="insideRight"
                        offset={4}
                        className="fill-background"
                        fontSize={11}
                        formatter={(value: number) => `${Math.round(value)}ms`}
                      />
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>
          </div>

          <Card className="border-muted/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Latency Hotspots by Feature</CardTitle>
              <CardDescription>
                Highest p99 features across the project interval from Tinybird.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {featureHotspots.length === 0 ? (
                <EmptyPlaceholder className="m-4 h-[320px] border border-dashed">
                  <EmptyPlaceholder.Icon>
                    <Activity className="h-8 w-8 opacity-30" />
                  </EmptyPlaceholder.Icon>
                  <EmptyPlaceholder.Title>No feature hotspots yet</EmptyPlaceholder.Title>
                  <EmptyPlaceholder.Description>
                    As verification events arrive, the slowest features will be listed here.
                  </EmptyPlaceholder.Description>
                </EmptyPlaceholder>
              ) : (
                <ScrollArea className="h-[420px] lg:h-[520px]">
                  <div className="divide-y">
                    {featureHotspots.map((row) => (
                      <div
                        key={row.feature_slug}
                        className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-sm">{row.feature_slug}</p>
                          <p className="text-muted-foreground text-xs">{row.count} verifications</p>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <Badge variant="secondary" className="font-mono">
                            p50 {Math.round(row.p50_latency)}ms
                          </Badge>
                          <Badge variant="secondary" className="font-mono">
                            p95 {Math.round(row.p95_latency)}ms
                          </Badge>
                          <Badge variant="outline" className="font-mono">
                            p99 {Math.round(row.p99_latency)}ms
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
