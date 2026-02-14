"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"

import { useSuspenseQuery } from "@tanstack/react-query"
import { BarChart3, BarChartBig } from "lucide-react"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

export const description = "An interactive bar chart"

const chartConfig = {
  usage: {
    label: "Usage",
    color: "var(--chart-4)",
    icon: BarChartBig,
  },
  latency: {
    label: "Latency",
    color: "var(--chart-1)",
    icon: BarChartBig,
  },
  verifications: {
    label: "Verifications",
    color: "var(--chart-3)",
    icon: BarChartBig,
  },
} satisfies ChartConfig

const chartKeys = Object.keys(chartConfig) as Array<keyof typeof chartConfig>

export function FeaturesStatsSkeleton({
  isLoading,
  error,
}: {
  isLoading: boolean
  error?: string
}) {
  const [intervalFilter] = useIntervalFilter()

  return (
    <Card className="flex min-h-[560px] flex-col overflow-hidden py-0">
      <CardHeader className="!p-0 flex flex-col items-stretch space-y-0 border-b md:flex-row">
        <div className="md:!py-0 flex flex-1 flex-col justify-center gap-1 px-6 pt-4 pb-3 md:w-1/2">
          <CardTitle>Verifications</CardTitle>
          <CardDescription>
            Showing consumption behavior for the {intervalFilter.label}
          </CardDescription>
        </div>
        <div className="flex space-y-0 md:w-1/2">
          {chartKeys.map((chart) => {
            return (
              <button
                type="button"
                key={chart}
                className="relative z-30 flex flex-1 flex-col justify-center gap-1 border-t px-6 py-4 text-left even:border-l data-[active=true]:bg-muted md:border-t-0 md:border-l md:px-8 md:py-6"
              >
                <span className="line-clamp-1 text-muted-foreground text-xs">
                  {chartConfig[chart].label}
                </span>
                <span className="font-bold text-lg leading-none md:text-3xl">0</span>
              </button>
            )
          })}
        </div>
      </CardHeader>
      <CardContent className="flex-1 px-2 pb-3 md:px-6 md:pt-3 md:pb-6">
        <EmptyPlaceholder className="min-h-[420px] md:min-h-[520px]" isLoading={isLoading}>
          <EmptyPlaceholder.Icon>
            <BarChart3 className="h-8 w-8" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>
            {error ? "Ups, something went wrong" : "No data available"}
          </EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            {error
              ? error
              : `There is no data available for the ${intervalFilter.label}. Please try again later.`}
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

export function FeaturesStats() {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const isNearRealtime = intervalFilter.intervalDays === 1

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

  const {
    data: featuresOverview,
    isLoading,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.analytics.getFeaturesOverview.queryOptions(
      {
        interval_days: intervalFilter.intervalDays,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        staleTime: isNearRealtime ? 45 * 1000 : 5 * 60 * 1000,
        refetchInterval: isNearRealtime ? 60 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  // invalidate the query when the interval changes
  useQueryInvalidation({
    paramKey: intervalFilter.intervalDays,
    dataUpdatedAt,
    isFetching,
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

  const chartData = featuresOverview.data

  const [activeChart, setActiveChart] = React.useState<keyof typeof chartConfig>("verifications")

  const activeGradientId = React.useMemo(() => `features-stats-fill-${activeChart}`, [activeChart])

  const total = React.useMemo(
    () => ({
      usage: chartData.reduce((acc, curr) => acc + curr.usage, 0),
      latency: chartData.length > 0 ? Math.max(...chartData.map((item) => item.latency)) : 0,
      verifications: chartData.reduce((acc, curr) => acc + curr.verifications, 0),
    }),
    [chartData]
  )

  if (isLoading || !chartData || chartData.length === 0) {
    return <FeaturesStatsSkeleton isLoading={isLoading} error={featuresOverview.error} />
  }

  return (
    <Card className="flex min-h-[560px] flex-col overflow-hidden py-0">
      <CardHeader className="!p-0 flex flex-col items-stretch space-y-0 border-b md:flex-row">
        <div className="md:!py-0 flex flex-1 flex-col justify-center gap-1 px-6 pt-4 pb-3 md:w-1/2">
          <CardTitle>{chartConfig[activeChart].label}</CardTitle>
          <CardDescription>
            Showing consumption behavior for the {intervalFilter.label}
          </CardDescription>
        </div>
        <div className="flex space-y-0 md:w-1/2">
          {chartKeys.map((chart) => {
            const Icon = chartConfig[chart].icon

            return (
              <button
                type="button"
                key={chart}
                data-active={activeChart === chart}
                className="relative z-30 flex flex-1 flex-col justify-center gap-1 border-t px-5 py-4 text-left transition-colors even:border-l data-[active=true]:bg-muted/70 md:border-t-0 md:border-l md:px-7 md:py-6"
                onClick={() => setActiveChart(chart)}
              >
                <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
                  <Icon className="h-3.5 w-3.5" />
                  {chartConfig[chart].label}
                </span>
                <span className="flex items-center gap-1 font-bold text-lg leading-none sm:text-3xl">
                  <NumberTicker
                    value={total[chart]}
                    startValue={0}
                    decimalPlaces={0}
                    withFormatter={true}
                    isTime={chart === "latency"}
                  />
                </span>
              </button>
            )
          })}
        </div>
      </CardHeader>
      <CardContent className="flex-1 px-2 pb-3 md:px-6 md:pt-3 md:pb-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[55vh] max-h-[720px] min-h-[420px] w-full"
        >
          <AreaChart
            accessibilityLayer
            data={chartData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
              bottom: 10,
            }}
          >
            <defs>
              <linearGradient id={activeGradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${activeChart})`} stopOpacity={0.3} />
                <stop offset="95%" stopColor={`var(--color-${activeChart})`} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={formatXAxis}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={44}
              tickMargin={8}
              tickFormatter={(value) => {
                if (activeChart === "latency") {
                  return `${Math.round(value)}ms`
                }

                return Intl.NumberFormat("en-US", {
                  notation: "compact",
                  compactDisplay: "short",
                }).format(value)
              }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  className="w-[200px]"
                  nameKey="date"
                  labelKey="date"
                  labelFormatter={(_, item) => {
                    const date = new Date(item.at(0)?.payload.date)

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
                />
              }
            />
            <Area
              dataKey={activeChart}
              type="monotone"
              stroke={`var(--color-${activeChart})`}
              fill={`url(#${activeGradientId})`}
              strokeWidth={2.2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
