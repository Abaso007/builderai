"use client"

import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "@unprice/ui/chart"
import { Skeleton } from "@unprice/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { Activity, BarChart2, Globe, RefreshCw, Users } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useUsageDuckdb } from "~/hooks/use-usage-duckdb"

// ============================================================================
// Types
// ============================================================================

interface MetricData {
  totalEvents: number
  totalUsage: number
  uniqueCustomers: number
  uniqueFeatures: number
}

interface TimeSeriesData {
  date: string
  usage: number
  events: number
}

interface FeatureData {
  feature: string
  usage: number
  events: number
}

interface RegionData {
  region: string
  events: number
  percentage: number
}

interface CustomerData {
  customer_id: string
  total_usage: number
  event_count: number
  features_used: number
}

interface FeatureBreakdownItem {
  feature: string
  events: number
  percentage: number
}

// ============================================================================
// SQL Queries
// ============================================================================

const QUERIES = {
  metrics: `
    SELECT
      COUNT(*) as total_events,
      COALESCE(SUM(usage), 0) as total_usage,
      COUNT(DISTINCT customer_id) as unique_customers,
      COUNT(DISTINCT feature_slug) as unique_features
    FROM usage_events
    WHERE deleted = 0
  `,

  usageByDay: `
    SELECT
      strftime(to_timestamp(timestamp / 1000), '%Y-%m-%d') as date,
      COALESCE(SUM(usage), 0) as usage,
      COUNT(*) as events
    FROM usage_events
    WHERE deleted = 0
    GROUP BY date
    ORDER BY date ASC
  `,

  topFeatures: `
    SELECT
      feature_slug as feature,
      COALESCE(SUM(usage), 0) as usage,
      COUNT(*) as events
    FROM usage_events
    WHERE deleted = 0
    GROUP BY feature_slug
    ORDER BY usage DESC
    LIMIT 10
  `,

  regionDistribution: `
    SELECT
      COALESCE(region, 'Unknown') as region,
      COUNT(*) as events
    FROM usage_events
    WHERE deleted = 0
    GROUP BY region
    ORDER BY events DESC
    LIMIT 8
  `,

  topCustomers: `
    SELECT
      customer_id,
      COALESCE(SUM(usage), 0) as total_usage,
      COUNT(*) as event_count,
      COUNT(DISTINCT feature_slug) as features_used
    FROM usage_events
    WHERE deleted = 0
    GROUP BY customer_id
    ORDER BY total_usage DESC
    LIMIT 10
  `,

  all: `
    SELECT
      *
    FROM usage_events
    WHERE deleted = 0
  `,
}

// ============================================================================
// Chart Configs
// ============================================================================

const usageChartConfig: ChartConfig = {
  usage: {
    label: "Usage",
    color: "hsl(var(--chart-1))",
  },
  events: {
    label: "Events",
    color: "hsl(var(--chart-2))",
  },
}

const featureChartConfig: ChartConfig = {
  usage: {
    label: "Total Usage",
    color: "hsl(var(--chart-1))",
  },
}

const regionChartConfig: ChartConfig = {
  events: {
    label: "Events",
    color: "hsl(var(--chart-3))",
  },
}

const pieChartConfig: ChartConfig = {
  events: {
    label: "Events",
  },
}

// Explicit colors for charts so they are visible (CSS vars can fail in SVG)
const PIE_CHART_COLORS = [
  "hsl(221, 83%, 53%)",
  "hsl(142, 76%, 36%)",
  "hsl(47, 96%, 53%)",
  "hsl(346, 77%, 50%)",
  "hsl(262, 83%, 58%)",
  "hsl(173, 58%, 39%)",
]
const BAR_FILL_FEATURES = "hsl(221, 83%, 53%)"
const BAR_FILL_REGION = "hsl(173, 58%, 39%)"

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

// ============================================================================
// Sub-Components
// ============================================================================

function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  isLoading,
}: {
  title: string
  value: string | number
  subtitle?: string
  icon: React.ComponentType<{ className?: string }>
  isLoading?: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="font-medium text-sm">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <div className="font-bold text-2xl tabular-nums">
              {typeof value === "number" ? value.toLocaleString() : value}
            </div>
            {subtitle && <p className="text-muted-foreground text-xs">{subtitle}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ChartSkeleton({ height = 300 }: { height?: number }) {
  return (
    <div className="flex items-center justify-center" style={{ height }}>
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-8 w-8 rounded-full" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  )
}

// ============================================================================
// Main Dashboard Component
// ============================================================================

export function LakehouseDashboard({ projectId }: { projectId?: string }) {
  const {
    isReady,
    isLoading,
    isInitializing,
    runCustomQuery,
    loadedFileCount,
    totalEvents,
    error,
  } = useUsageDuckdb(projectId ?? "")

  const [isQuerying, setIsQuerying] = useState(false)
  const [metrics, setMetrics] = useState<MetricData | null>(null)
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesData[]>([])
  const [featureData, setFeatureData] = useState<FeatureData[]>([])
  const [regionData, setRegionData] = useState<RegionData[]>([])
  const [customerData, setCustomerData] = useState<CustomerData[]>([])

  // Fetch all dashboard data
  const fetchDashboardData = useCallback(async () => {
    if (!isReady) return

    setIsQuerying(true)
    try {
      // Run all queries in parallel
      const [metricsRes, timeSeriesRes, featuresRes, regionRes, customersRes, allRes] =
        await Promise.all([
          runCustomQuery(QUERIES.metrics),
          runCustomQuery(QUERIES.usageByDay),
          runCustomQuery(QUERIES.topFeatures),
          runCustomQuery(QUERIES.regionDistribution),
          runCustomQuery(QUERIES.topCustomers),
          runCustomQuery(QUERIES.all),
        ])

      console.log(allRes)

      // Process metrics (use toNumber so we never get NaN; read by column name in case casing differs)
      if (metricsRes?.rows?.[0] && metricsRes?.columns) {
        const row = metricsRes.rows[0] as Record<string, unknown>
        const get = (key: string) => {
          const exact = row[key]
          if (exact !== undefined && exact !== null) return exact
          const lower = (metricsRes.columns as string[]).find(
            (c) => c.toLowerCase() === key.toLowerCase()
          )
          return lower !== undefined ? row[lower] : undefined
        }
        setMetrics({
          totalEvents: toNumber(get("total_events")),
          totalUsage: toNumber(get("total_usage")),
          uniqueCustomers: toNumber(get("unique_customers")),
          uniqueFeatures: toNumber(get("unique_features")),
        })
      }

      // Process time series
      if (timeSeriesRes?.rows) {
        setTimeSeriesData(
          timeSeriesRes.rows.map((row) => {
            const r = row as Record<string, unknown>
            return {
              date: String(r.date ?? ""),
              usage: Number(r.usage ?? 0),
              events: Number(r.events ?? 0),
            }
          })
        )
      }

      // Process features
      if (featuresRes?.rows) {
        setFeatureData(
          featuresRes.rows.map((row) => {
            const r = row as Record<string, unknown>
            return {
              feature: String(r.feature ?? "unknown"),
              usage: Number(r.usage ?? 0),
              events: Number(r.events ?? 0),
            }
          })
        )
      }

      // Process regions
      if (regionRes?.rows) {
        const totalRegionEvents = regionRes.rows.reduce(
          (sum, row) => sum + Number((row as Record<string, unknown>).events ?? 0),
          0
        )
        setRegionData(
          regionRes.rows.map((row) => {
            const r = row as Record<string, unknown>
            const events = Number(r.events ?? 0)
            return {
              region: String(r.region ?? "Unknown"),
              events,
              percentage: totalRegionEvents > 0 ? (events / totalRegionEvents) * 100 : 0,
            }
          })
        )
      }

      // Process customers
      if (customersRes?.rows) {
        setCustomerData(
          customersRes.rows.map((row) => {
            const r = row as Record<string, unknown>
            return {
              customer_id: String(r.customer_id ?? "unknown"),
              total_usage: Number(r.total_usage ?? 0),
              event_count: Number(r.event_count ?? 0),
              features_used: Number(r.features_used ?? 0),
            }
          })
        )
      }
    } catch (e) {
      console.error("Dashboard query error:", e)
    } finally {
      setIsQuerying(false)
    }
  }, [isReady, runCustomQuery])

  // Fetch data when ready
  useEffect(() => {
    if (isReady) {
      void fetchDashboardData()
    }
  }, [isReady, fetchDashboardData])

  const showLoading = isLoading || isInitializing || isQuerying

  // Features breakdown for pie (from featureData, with percentage by events)
  const featureBreakdownData: FeatureBreakdownItem[] = (() => {
    if (featureData.length === 0) return []
    const total = featureData.reduce((s, f) => s + f.events, 0)
    if (total === 0) return []
    return featureData.map((f) => ({
      feature: f.feature,
      events: f.events,
      percentage: (f.events / total) * 100,
    }))
  })()

  // Format usage value for display (guards against NaN)
  const formatUsage = (value: number): string => {
    const n = Number.isFinite(value) ? value : 0
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toLocaleString()
  }

  // Truncate customer ID for display
  const truncateId = (id: string, maxLen = 30): string => {
    if (id.length <= maxLen) return id
    return `${id.slice(0, maxLen)}...`
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-2xl tracking-tight">Usage Analytics</h2>
          <p className="text-muted-foreground text-sm">
            {isReady
              ? `${loadedFileCount} files loaded, ${totalEvents.toLocaleString()} events`
              : isInitializing
                ? "Initializing DuckDB..."
                : isLoading
                  ? "Loading data..."
                  : "Ready to load data"}
          </p>
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={fetchDashboardData}
          disabled={!isReady || showLoading}
          title="Refresh data"
        >
          <RefreshCw className={`h-4 w-4 ${isQuerying ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Error State */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Hero Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Events"
          value={metrics?.totalEvents ?? 0}
          subtitle="All recorded events"
          icon={Activity}
          isLoading={showLoading}
        />
        <MetricCard
          title="Total Usage"
          value={formatUsage(metrics?.totalUsage ?? 0)}
          subtitle="Aggregated usage units"
          icon={BarChart2}
          isLoading={showLoading}
        />
        <MetricCard
          title="Unique Customers"
          value={metrics?.uniqueCustomers ?? 0}
          subtitle="Active customers"
          icon={Users}
          isLoading={showLoading}
        />
        <MetricCard
          title="Features Used"
          value={metrics?.uniqueFeatures ?? 0}
          subtitle="Distinct features"
          icon={Globe}
          isLoading={showLoading}
        />
      </div>

      {/* Main Charts Row */}
      <div className="grid gap-4 lg:grid-cols-7">
        {/* Usage Over Time - Large Chart */}
        <Card className="lg:col-span-4">
          <CardHeader>
            <CardTitle>Usage Over Time</CardTitle>
            <CardDescription>Daily usage and event trends</CardDescription>
          </CardHeader>
          <CardContent>
            {showLoading ? (
              <ChartSkeleton height={350} />
            ) : timeSeriesData.length === 0 ? (
              <div className="flex h-[350px] items-center justify-center text-muted-foreground text-sm">
                No data available for this time range
              </div>
            ) : (
              <ChartContainer config={usageChartConfig} className="h-[350px] w-full">
                <AreaChart
                  data={timeSeriesData}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="usageGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="eventsGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => {
                      const date = new Date(value)
                      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    }}
                  />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={formatUsage} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(value) => {
                          return new Date(value).toLocaleDateString("en-US", {
                            month: "long",
                            day: "numeric",
                            year: "numeric",
                          })
                        }}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="usage"
                    stroke="hsl(var(--chart-1))"
                    strokeWidth={2}
                    fill="url(#usageGradient)"
                  />
                  <Area
                    type="monotone"
                    dataKey="events"
                    stroke="hsl(var(--chart-2))"
                    strokeWidth={2}
                    fill="url(#eventsGradient)"
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Features Breakdown - Pie Chart */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Features Breakdown</CardTitle>
            <CardDescription>Distribution by feature</CardDescription>
          </CardHeader>
          <CardContent>
            {showLoading ? (
              <ChartSkeleton height={350} />
            ) : featureBreakdownData.length === 0 ? (
              <div className="flex h-[350px] items-center justify-center text-muted-foreground text-sm">
                No feature data available
              </div>
            ) : (
              <div className="h-[350px]">
                <ChartContainer
                  config={pieChartConfig}
                  className="mx-auto aspect-square max-h-[350px]"
                >
                  <PieChart>
                    <Pie
                      data={featureBreakdownData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={2}
                      dataKey="events"
                      nameKey="feature"
                      label={({ feature, percentage }) =>
                        `${feature.length > 12 ? `${feature.slice(0, 12)}...` : feature} (${percentage.toFixed(1)}%)`
                      }
                      labelLine={false}
                    >
                      {featureBreakdownData.map((entry, index) => (
                        <Cell
                          key={entry.feature}
                          fill={PIE_CHART_COLORS[index % PIE_CHART_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <ChartTooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const data = payload[0]?.payload as FeatureBreakdownItem
                        return (
                          <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
                            <p className="font-medium">{data.feature}</p>
                            <p className="text-muted-foreground text-sm">
                              {data.events.toLocaleString()} events ({data.percentage.toFixed(1)}%)
                            </p>
                          </div>
                        )
                      }}
                    />
                  </PieChart>
                </ChartContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Second Row */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Top Features */}
        <Card>
          <CardHeader>
            <CardTitle>Top Features</CardTitle>
            <CardDescription>Features ranked by total usage</CardDescription>
          </CardHeader>
          <CardContent>
            {showLoading ? (
              <ChartSkeleton height={300} />
            ) : featureData.length === 0 ? (
              <div className="flex h-[300px] items-center justify-center text-muted-foreground text-sm">
                No feature data available
              </div>
            ) : (
              <ChartContainer config={featureChartConfig} className="h-[300px] w-full">
                <BarChart
                  data={featureData}
                  layout="vertical"
                  margin={{ top: 0, right: 20, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={formatUsage}
                  />
                  <YAxis
                    type="category"
                    dataKey="feature"
                    tickLine={false}
                    axisLine={false}
                    width={120}
                    tickFormatter={(value) =>
                      value.length > 15 ? `${value.slice(0, 15)}...` : value
                    }
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, _name, props) => (
                          <div className="flex flex-col gap-1">
                            <span className="font-medium">{props.payload.feature}</span>
                            <span>Usage: {Number(value).toLocaleString()}</span>
                            <span className="text-muted-foreground">
                              {props.payload.events.toLocaleString()} events
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Bar dataKey="usage" fill={BAR_FILL_FEATURES} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Geographic Distribution */}
        <Card>
          <CardHeader>
            <CardTitle>Geographic Distribution</CardTitle>
            <CardDescription>Events by region</CardDescription>
          </CardHeader>
          <CardContent>
            {showLoading ? (
              <ChartSkeleton height={300} />
            ) : regionData.length === 0 ? (
              <div className="flex h-[300px] items-center justify-center text-muted-foreground text-sm">
                No region data available
              </div>
            ) : (
              <ChartContainer config={regionChartConfig} className="h-[300px] w-full">
                <BarChart data={regionData} margin={{ top: 0, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis
                    dataKey="region"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => (value === "Unknown" ? "UNK" : value)}
                  />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={formatUsage} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, _name, props) => (
                          <div className="flex flex-col gap-1">
                            <span className="font-medium">{props.payload.region}</span>
                            <span>{Number(value).toLocaleString()} events</span>
                            <span className="text-muted-foreground">
                              {props.payload.percentage.toFixed(1)}% of total
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Bar dataKey="events" fill={BAR_FILL_REGION} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Customer Activity Table */}
      <Card>
        <CardHeader>
          <CardTitle>Top Customers</CardTitle>
          <CardDescription>Customers ranked by total usage</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer ID</TableHead>
                  <TableHead className="text-right">Total Usage</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">Features Used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {showLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={`skeleton-${i.toString()}`}>
                      <TableCell>
                        <Skeleton className="h-4 w-32" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Skeleton className="ml-auto h-4 w-16" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Skeleton className="ml-auto h-4 w-12" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Skeleton className="ml-auto h-4 w-8" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : customerData.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      No customer data available
                    </TableCell>
                  </TableRow>
                ) : (
                  customerData.map((customer) => (
                    <TableRow key={customer.customer_id}>
                      <TableCell className="font-mono text-sm">
                        {truncateId(customer.customer_id)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatUsage(customer.total_usage)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {customer.event_count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {customer.features_used}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
