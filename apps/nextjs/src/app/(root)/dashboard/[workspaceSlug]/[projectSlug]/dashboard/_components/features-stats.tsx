"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { regionsCloudflare } from "@unprice/analytics/utils"
import { nFormatter } from "@unprice/db/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Skeleton } from "@unprice/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import {
  Activity,
  CircleHelp,
  Gauge,
  Globe2,
  LineChart as LineChartIcon,
  TriangleAlert,
} from "lucide-react"
import * as React from "react"
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  XAxis,
  YAxis,
} from "recharts"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

export const description = "Unified analytics overview"

const trendChartConfig = {
  usage: { label: "Usage reported", color: "var(--chart-4)" },
  verifications: { label: "Verifications", color: "var(--chart-3)" },
  latency: { label: "Latency p99", color: "var(--chart-1)" },
} satisfies ChartConfig

const regionsChartConfig = {
  p99Latency: { label: "P99 latency", color: "var(--chart-1)" },
} satisfies ChartConfig

function InfoTooltip({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="More metric details"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-xs">{content}</TooltipContent>
    </Tooltip>
  )
}

function formatRegion(regionCode: string) {
  const code = regionCode.toUpperCase()
  const region = regionsCloudflare[code]

  if (!region) {
    return code
  }

  return `${region.location} (${code})`
}

export function FeaturesStatsSkeleton({ intervalLabel }: { intervalLabel?: string }) {
  return (
    <Card className="overflow-hidden border-muted/60">
      <CardHeader>
        <CardTitle>Overview Intelligence</CardTitle>
        <CardDescription>Loading trend, feature matrix, and region latency data...</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          {["verifications", "usage", "latency"].map((item) => {
            return (
              <Card key={`overview-metric-skeleton-${item}`} className="border-muted/60">
                <CardContent className="space-y-2 px-4 py-3">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-8 w-20" />
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div className="overflow-hidden rounded-md border border-border/60">
          <Skeleton className="h-[360px] w-full" />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
          <Skeleton className="h-[320px] w-full rounded-md" />
          <Skeleton className="h-[320px] w-full rounded-md" />
        </div>

        <p className="text-muted-foreground text-xs">
          Fetching usage and verification activity{intervalLabel ? ` for ${intervalLabel}` : ""}.
        </p>
      </CardContent>
    </Card>
  )
}

function FeaturesStatsEmptyState({ intervalLabel }: { intervalLabel: string }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Overview Intelligence</CardTitle>
        <CardDescription>
          Unified view of usage reported, verifications, and latency for the {intervalLabel}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="min-h-[520px] transition-opacity duration-300">
          <EmptyPlaceholder.Icon>
            <LineChartIcon className="h-8 w-8 opacity-50 motion-safe:animate-pulse" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No analytics data yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Report usage or run verifications to populate trend, feature activity, and regional
            latency insights.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

function FeaturesStatsErrorState({ error }: { error: string }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Overview Intelligence</CardTitle>
        <CardDescription>Analytics data could not be loaded right now.</CardDescription>
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="min-h-[520px]">
          <EmptyPlaceholder.Icon>
            <TriangleAlert className="h-8 w-8 opacity-60" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Unable to load analytics</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>{error}</EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

export function FeaturesStats() {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const compactFormatter = React.useMemo(
    () => new Intl.NumberFormat("en-US", { notation: "compact", compactDisplay: "short" }),
    []
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
        ...ANALYTICS_CONFIG_REALTIME,
        placeholderData: (previousData) => previousData,
        staleTime: isNearRealtime ? 45 * 1000 : 5 * 60 * 1000,
        refetchInterval: isNearRealtime ? 60 * 1000 : (false as const),
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
        ...ANALYTICS_CONFIG_REALTIME,
        placeholderData: (previousData) => previousData,
        staleTime: isNearRealtime ? 60 * 1000 : 5 * 60 * 1000,
        refetchInterval: isNearRealtime ? 120 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  const {
    data: usage,
    dataUpdatedAt: usageUpdatedAt,
    isFetching: isUsageFetching,
  } = useSuspenseQuery(
    trpc.analytics.getUsage.queryOptions(
      {
        interval_days: intervalFilter.intervalDays,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        placeholderData: (previousData) => previousData,
        staleTime: isNearRealtime ? 60 * 1000 : 5 * 60 * 1000,
        refetchInterval: isNearRealtime ? 120 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

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
        ...ANALYTICS_CONFIG_REALTIME,
        placeholderData: (previousData) => previousData,
        staleTime: isNearRealtime ? 60 * 1000 : 5 * 60 * 1000,
        refetchInterval: isNearRealtime ? 120 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

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
    dataUpdatedAt: usageUpdatedAt,
    isFetching: isUsageFetching,
    getQueryKey: (param) => [
      ["analytics", "getUsage"],
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

  const trendRows = featuresOverview.data ?? []
  const verificationRows = verifications.verifications ?? []
  const usageRows = usage.usage ?? []
  const regionRows = verificationRegions.verifications ?? []

  const totals = React.useMemo(() => {
    const totalVerifications = verificationRows.reduce((sum, row) => sum + row.count, 0)
    const totalUsageReported = usageRows.reduce((sum, row) => sum + row.sum, 0)
    const peakLatency = Math.max(
      0,
      ...verificationRows.map((row) => row.p99_latency),
      ...trendRows.map((row) => row.latency)
    )

    return {
      totalVerifications,
      totalUsageReported,
      peakLatency,
    }
  }, [verificationRows, usageRows, trendRows])

  const featureMatrixRows = React.useMemo(() => {
    const normalizeFeatureSlug = (value: string) => value.trim().toLowerCase()

    const byFeature = new Map<
      string,
      {
        featureSlug: string
        verificationCount: number
        usageCount: number
      }
    >()

    for (const row of usageRows) {
      const featureSlug = row.feature_slug.trim()
      if (!featureSlug) {
        continue
      }

      const key = normalizeFeatureSlug(featureSlug)
      const existing = byFeature.get(key)

      if (existing) {
        existing.usageCount += row.count
        continue
      }

      byFeature.set(key, {
        featureSlug,
        verificationCount: 0,
        usageCount: row.count,
      })
    }

    for (const row of verificationRows) {
      const featureSlug = row.feature_slug.trim()
      if (!featureSlug) {
        continue
      }

      const key = normalizeFeatureSlug(featureSlug)
      const existing = byFeature.get(key)

      if (!existing) {
        byFeature.set(key, {
          featureSlug,
          verificationCount: row.count,
          usageCount: 0,
        })
        continue
      }

      existing.verificationCount += row.count
    }

    return Array.from(byFeature.values()).sort(
      (a, b) =>
        b.verificationCount + b.usageCount - (a.verificationCount + a.usageCount) ||
        b.verificationCount - a.verificationCount
    )
  }, [usageRows, verificationRows])

  const visibleFeatureActivityTotal = React.useMemo(() => {
    return featureMatrixRows.reduce((sum, row) => sum + row.verificationCount + row.usageCount, 0)
  }, [featureMatrixRows])

  const topRegionRows = React.useMemo(() => {
    const byRegion = new Map<
      string,
      {
        region: string
        checks: number
        p99Latency: number
      }
    >()

    for (const row of regionRows) {
      if (!row.region) {
        continue
      }

      const code = row.region.toUpperCase()
      const existing = byRegion.get(code)

      if (!existing) {
        byRegion.set(code, {
          region: code,
          checks: row.count,
          p99Latency: row.p99_latency,
        })
        continue
      }

      existing.checks += row.count
      existing.p99Latency = Math.max(existing.p99Latency, row.p99_latency)
    }

    return Array.from(byRegion.values())
      .sort((a, b) => b.p99Latency - a.p99Latency || b.checks - a.checks)
      .slice(0, 8)
      .map((row) => ({
        ...row,
        regionLabel: formatRegion(row.region),
      }))
  }, [regionRows])

  const hasTrendData = trendRows.some(
    (row) => row.verifications > 0 || row.usage > 0 || row.latency > 0
  )

  const isEmpty = !hasTrendData && featureMatrixRows.length === 0 && topRegionRows.length === 0
  const isRefreshing =
    isOverviewFetching || isVerificationsFetching || isUsageFetching || isRegionsFetching

  const formatXAxis = React.useCallback(
    (value: string) => {
      const date = new Date(value)

      if (Number.isNaN(date.getTime())) {
        return "--"
      }

      if (intervalFilter.intervalDays === 1) {
        return date.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })
      }

      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    },
    [intervalFilter.intervalDays]
  )

  if (featuresOverview.error) {
    return <FeaturesStatsErrorState error={featuresOverview.error} />
  }

  if (isEmpty) {
    return <FeaturesStatsEmptyState intervalLabel={intervalFilter.label} />
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-muted/60">
        <div
          className={cn(
            "pointer-events-none h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent transition-opacity duration-300",
            isRefreshing ? "opacity-100" : "opacity-0"
          )}
        />
        <CardHeader className="pb-2">
          <CardTitle>Overview Intelligence</CardTitle>
          <CardDescription>
            Unified view of usage reported, verifications, and latency for the{" "}
            {intervalFilter.label}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Card className="border-muted/60">
              <CardContent className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="inline-flex items-center gap-1.5">
                    <p className="text-muted-foreground text-xs">Total verifications</p>
                    <InfoTooltip content="Count of verification checks executed for project features in the selected interval." />
                  </div>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="font-semibold text-xl">
                  <NumberTicker value={totals.totalVerifications} withFormatter={true} />
                </p>
              </CardContent>
            </Card>

            <Card className="border-muted/60">
              <CardContent className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="inline-flex items-center gap-1.5">
                    <p className="text-muted-foreground text-xs">Usage reported</p>
                    <InfoTooltip content="Sum of usage units reported through usage events across all features." />
                  </div>
                  <LineChartIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="font-semibold text-xl">
                  <NumberTicker value={totals.totalUsageReported} withFormatter={true} />
                </p>
              </CardContent>
            </Card>

            <Card className="border-muted/60">
              <CardContent className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="inline-flex items-center gap-1.5">
                    <p className="text-muted-foreground text-xs">Peak latency p99</p>
                    <InfoTooltip content="Worst 99th percentile latency observed in the selected interval. Lower is better." />
                  </div>
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="font-semibold text-xl">
                  <NumberTicker value={totals.peakLatency} decimalPlaces={1} isTime={true} />
                </p>
              </CardContent>
            </Card>
          </div>

          <ChartContainer
            config={trendChartConfig}
            className="aspect-auto h-[55vh] max-h-[720px] min-h-[420px] w-full"
          >
            <ComposedChart
              accessibilityLayer
              data={trendRows}
              margin={{
                left: 10,
                right: 10,
                top: 12,
                bottom: 10,
              }}
            >
              <defs>
                <linearGradient id="fillUsageTrend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-usage)" stopOpacity={0.26} />
                  <stop offset="95%" stopColor="var(--color-usage)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="fillVerificationTrend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-verifications)" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="var(--color-verifications)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} className="stroke-muted" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                minTickGap={32}
                tickMargin={8}
                tickFormatter={formatXAxis}
              />
              <YAxis
                yAxisId="volume"
                axisLine={false}
                tickLine={false}
                width={56}
                tickMargin={8}
                tickFormatter={(value) => compactFormatter.format(value)}
              />
              <YAxis
                yAxisId="latency"
                orientation="right"
                axisLine={false}
                tickLine={false}
                width={52}
                tickMargin={8}
                tickFormatter={(value) => `${Math.round(value)}ms`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(_, payload) => {
                      const date = new Date(String(payload.at(0)?.payload.date ?? ""))

                      if (Number.isNaN(date.getTime())) {
                        return "Invalid date"
                      }

                      if (intervalFilter.intervalDays === 1) {
                        return date.toLocaleTimeString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      }

                      return date.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    }}
                    formatter={(value, name, item) => {
                      if (typeof value !== "number") {
                        return value
                      }

                      const label = String(name)
                      const indicatorColor =
                        item?.color || item?.payload?.fill || "var(--muted-foreground)"

                      return (
                        <>
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                              style={{ backgroundColor: indicatorColor }}
                            />
                            <span>
                              {trendChartConfig[label as keyof typeof trendChartConfig]?.label ??
                                label}
                            </span>
                          </span>
                          <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                            {label === "latency" ? `${Math.round(value)}ms` : nFormatter(value)}
                          </span>
                        </>
                      )
                    }}
                  />
                }
              />
              <Area
                yAxisId="volume"
                dataKey="usage"
                type="monotone"
                stroke="var(--color-usage)"
                fill="url(#fillUsageTrend)"
                strokeWidth={2}
                dot={false}
              />
              <Area
                yAxisId="volume"
                dataKey="verifications"
                type="monotone"
                stroke="var(--color-verifications)"
                fill="url(#fillVerificationTrend)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                yAxisId="latency"
                dataKey="latency"
                type="monotone"
                stroke="var(--color-latency)"
                strokeWidth={1}
                strokeDasharray="7 5"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Card className="min-w-0 overflow-hidden border-muted/60">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Feature activity</CardTitle>
                <CardDescription>
                  Per-feature usage reported and verification count.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-hidden px-3 pt-0 pb-4 sm:px-4">
            {featureMatrixRows.length === 0 ? (
              <EmptyPlaceholder className="h-[280px] border border-dashed transition-opacity duration-300 sm:h-[320px]">
                <EmptyPlaceholder.Icon>
                  <LineChartIcon className="h-8 w-8 opacity-30 motion-safe:animate-pulse" />
                </EmptyPlaceholder.Icon>
                <EmptyPlaceholder.Title>No feature performance yet</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Usage and verification events will populate this matrix.
                </EmptyPlaceholder.Description>
              </EmptyPlaceholder>
            ) : (
              <div className="overflow-hidden rounded-md border border-border/60">
                <ScrollArea
                  className="h-[360px] w-full px-3 py-3 sm:h-[460px] sm:px-4 lg:h-[560px] [&_[data-radix-scroll-area-scrollbar]]:hidden [&_[data-radix-scroll-area-viewport]]:overflow-x-hidden"
                  hideScrollBar
                >
                  <div className="space-y-4">
                    {featureMatrixRows.map((row, index) => {
                      const featureActivity = row.verificationCount + row.usageCount
                      const activityShare =
                        visibleFeatureActivityTotal > 0
                          ? (featureActivity / visibleFeatureActivityTotal) * 100
                          : 0

                      return (
                        <div key={row.featureSlug} className="space-y-1.5">
                          <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
                            <span className="min-w-0 truncate font-medium">{row.featureSlug}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground sm:text-xs">
                              {nFormatter(featureActivity)} events
                              <span className="hidden sm:inline">
                                {" "}
                                · {activityShare.toFixed(1)}%
                              </span>
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full transition-[width] duration-500 ease-out"
                              style={{
                                backgroundColor: `var(--chart-${(index % 5) + 1})`,
                                width: `${featureActivity > 0 ? Math.max(activityShare, 2) : 0}%`,
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground sm:text-xs">
                            <span>verif. {nFormatter(row.verificationCount)}</span>
                            <span>usage {nFormatter(row.usageCount)}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 border-muted/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Latency by region</CardTitle>
            <CardDescription>Region hotspots by p99 latency and verification load.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-hidden">
            {topRegionRows.length === 0 ? (
              <EmptyPlaceholder className="h-[280px] border border-dashed transition-opacity duration-300 sm:h-[320px]">
                <EmptyPlaceholder.Icon>
                  <Globe2 className="h-8 w-8 opacity-30 motion-safe:animate-pulse" />
                </EmptyPlaceholder.Icon>
                <EmptyPlaceholder.Title>No regional latency yet</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Region latency appears as verification traffic grows.
                </EmptyPlaceholder.Description>
              </EmptyPlaceholder>
            ) : (
              <ChartContainer
                config={regionsChartConfig}
                className="h-[320px] w-full min-w-0 max-w-full overflow-hidden sm:h-[460px] lg:h-[560px]"
              >
                <BarChart
                  accessibilityLayer
                  data={topRegionRows}
                  layout="vertical"
                  margin={{ top: 4, right: 10, left: 0, bottom: 4 }}
                  barCategoryGap="28%"
                >
                  <CartesianGrid horizontal={false} className="stroke-muted" />
                  <YAxis
                    dataKey="region"
                    type="category"
                    width={30}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickFormatter={(value: string) => value.toUpperCase()}
                  />
                  <XAxis dataKey="p99Latency" type="number" hide />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelFormatter={(_, payload) =>
                          formatRegion(String(payload.at(0)?.payload.region ?? "UNK"))
                        }
                        formatter={(value, name, item) => {
                          if (typeof value !== "number") {
                            return value
                          }

                          const checks = Number(item.payload.checks)
                          const label = String(name)

                          return (
                            <>
                              <span>
                                {regionsChartConfig[label as keyof typeof regionsChartConfig]
                                  ?.label ?? label}
                              </span>
                              <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                                {Math.round(value)}ms ({nFormatter(checks)} checks)
                              </span>
                            </>
                          )
                        }}
                      />
                    }
                  />
                  <Bar
                    dataKey="p99Latency"
                    fill="var(--color-p99Latency)"
                    radius={[4, 4, 4, 4]}
                    maxBarSize={34}
                  >
                    <LabelList
                      dataKey="p99Latency"
                      position="insideRight"
                      offset={4}
                      className="hidden fill-background font-mono sm:block"
                      formatter={(value: number) => `${Math.round(value)}ms`}
                    />
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
