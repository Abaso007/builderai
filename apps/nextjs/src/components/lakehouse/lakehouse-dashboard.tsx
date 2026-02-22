"use client"

import { DataTableArrowPaginated } from "@sqlrooms/data-table"
import { useSql } from "@sqlrooms/duckdb"
import { RoomShell } from "@sqlrooms/room-shell"
import { useQuery } from "@tanstack/react-query"
import { PREDEFINED_LAKEHOUSE_QUERIES, type PredefinedLakehouseQueryKey } from "@unprice/lakehouse"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@unprice/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  Database,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import dynamic from "next/dynamic"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useMounted } from "~/hooks/use-mounted"
import { useTRPC } from "~/trpc/client"
import {
  EXPECTED_LAG_MINUTES,
  QUICK_QUERY_KEYS,
  SECTION_MOTION,
  SNAPSHOT_STATUS,
  USAGE_TREND_CHART_CONFIG,
  VERIFICATION_TREND_CHART_CONFIG,
} from "./lakehouse-constants"
import { downloadArrowTableAsCsv } from "./lakehouse-utils"
import { roomStore, useRoomStore } from "./sqlrooms-store"
import { useCredentialRefresh } from "./use-credential-refresh"
import { useLakehouseAnalytics } from "./use-lakehouse-analytics"
import { useLakehouseLoader } from "./use-lakehouse-loader"

// ─── Lazy-loaded SQL editor ───────────────────────────────────────────────────

const SqlMonacoEditor = dynamic(
  () => import("@sqlrooms/sql-editor").then((m) => m.SqlMonacoEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[200px] items-center justify-center bg-muted/20 text-muted-foreground text-sm">
        Loading SQL editor...
      </div>
    ),
  }
)

// ─── Module-level helpers (no hook needed) ────────────────────────────────────

const numberFmt = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
})

function formatMinuteTick(value: string, sameDay: boolean): string {
  if (!value) return value
  return sameDay ? value.slice(11, 16) : value.slice(5, 16)
}

type RequiredTable = "usage" | "verifications" | "metadata" | "entitlement_snapshots"

function getRequiredTables(query: string): RequiredTable[] {
  const q = query.toLowerCase()
  const required: RequiredTable[] = []
  if (/\busage\b/.test(q)) required.push("usage")
  if (/\bverifications\b/.test(q)) required.push("verifications")
  if (/\bmetadata\b/.test(q)) required.push("metadata")
  if (/\bentitlement_snapshots\b/.test(q)) required.push("entitlement_snapshots")
  return required
}

// ─── Inner dashboard (needs store context from RoomShell) ─────────────────────

function LakehouseDashboardInner() {
  const trpc = useTRPC()
  const [interval] = useIntervalFilter()

  // ── SQL editor state ──────────────────────────────────────────────────────
  const [sqlQuery, setSqlQuery] = useState("")
  const [executedQuery, setExecutedQuery] = useState<string | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [manualQueryError, setManualQueryError] = useState<string | null>(null)

  const pendingScrollRef = useRef(false)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const sqlShellRef = useRef<HTMLDivElement | null>(null)

  // ── Store ─────────────────────────────────────────────────────────────────
  const getConnector = useRoomStore((s) => s.db.getConnector)
  const refreshTableSchemas = useRoomStore((s) => s.db.refreshTableSchemas)
  const setFilePlan = useRoomStore((s) => s.setFilePlan)
  const tables = useRoomStore((s) => s.db.tables)

  // ── Credentials ───────────────────────────────────────────────────────────
  const credentialsQuery = useQuery(
    trpc.analytics.getLakehouseFilePlan.queryOptions(
      { interval: interval.name },
      { staleTime: 1000 * 60 * 5 }
    )
  )

  // ── Loader ────────────────────────────────────────────────────────────────
  const handleTablesLoaded = useCallback((_newTables: string[], initialQuery: string) => {
    // Only set the initial query if the editor is currently empty
    setSqlQuery((prev) => prev || initialQuery)
  }, [])

  const {
    isLoadingData,
    loadingStep,
    loadError,
    loadedFileCount: _loadedFileCount, // consumed by loader internally
    loadedTables,
    loadDataIntoDb,
    resetLoader,
  } = useLakehouseLoader({
    credentialsData: credentialsQuery.data,
    onRefetch: () => void credentialsQuery.refetch(),
    getConnector,
    refreshTableSchemas,
    setFilePlan,
    onTablesLoaded: handleTablesLoaded,
  })

  // ── Auto-refresh credentials before they expire ───────────────────────────
  useCredentialRefresh(
    credentialsQuery.data?.result?.credentials ?? null,
    () => void credentialsQuery.refetch()
  )

  // ── Trigger load when credentials arrive ─────────────────────────────────
  useEffect(() => {
    if (credentialsQuery.data && !credentialsQuery.isLoading) void loadDataIntoDb()
  }, [credentialsQuery.data, credentialsQuery.isLoading, loadDataIntoDb])

  // ── Reset everything when the interval filter changes ─────────────────────
  useEffect(() => {
    resetLoader()
    setSqlQuery("")
    setExecutedQuery(null)
    setManualQueryError(null)
    setFilePlan(null)
  }, [interval, resetLoader, setFilePlan])

  // ── Derived booleans ──────────────────────────────────────────────────────
  const hasUsage = loadedTables.includes("usage")
  const hasVerification = loadedTables.includes("verifications")
  const hasMetadata = loadedTables.includes("metadata")
  const hasEntitlementSnapshots = loadedTables.includes("entitlement_snapshots")
  const tableReady = loadedTables.length > 0
  const isLoading = credentialsQuery.isLoading || isLoadingData
  const error = credentialsQuery.error?.message ?? loadError
  const isEmpty = !isLoading && !error && !tableReady

  // ── Analytics data ────────────────────────────────────────────────────────
  const {
    usageSummaryRow,
    verificationSummaryRow,
    metadataCoverageRow,
    usageTrendData,
    verificationTrendData,
    metadataCoveragePct,
    verificationPassRate,
    usageMinuteSameDay,
    verificationMinuteSameDay,
  } = useLakehouseAnalytics({ hasUsage, hasVerification, hasMetadata })

  // Derived display values
  const usageEvents = Number(usageSummaryRow?.events ?? 0)
  const usageTotal = Number(usageSummaryRow?.total_usage ?? 0)
  const verificationAllowed = Number(verificationSummaryRow?.allowed ?? 0)
  const verificationDenied = Number(verificationSummaryRow?.denied ?? 0)
  const metadataTagged = Number(metadataCoverageRow?.with_meta ?? 0)
  const metadataTotal = Number(metadataCoverageRow?.total ?? 0)

  // ── SQL query execution ───────────────────────────────────────────────────
  const {
    data: queryResult,
    isLoading: isQueryLoading,
    error: queryError,
  } = useSql({
    query: executedQuery ?? "",
    enabled: !!executedQuery && tableReady,
  })

  // Sync isExecuting with query lifecycle
  useEffect(() => {
    if (!isQueryLoading && isExecuting) setIsExecuting(false)
  }, [isQueryLoading, isExecuting])

  const showQueryLoading = isExecuting || isQueryLoading

  const runQuery = useCallback(
    (query: string, scroll = false) => {
      const missing = getRequiredTables(query).filter((t) => !loadedTables.includes(t))
      if (missing.length > 0) {
        setManualQueryError(`Missing table(s): ${missing.join(", ")}`)
        return
      }
      setManualQueryError(null)
      pendingScrollRef.current = scroll
      setIsExecuting(true)
      setExecutedQuery(`${query.trim()}\n-- run:${Date.now()}`)
    },
    [loadedTables]
  )

  const handleExecuteQuery = useCallback(() => {
    if (sqlQuery.trim()) runQuery(sqlQuery, false)
  }, [sqlQuery, runQuery])

  const handleApplyQuery = useCallback(
    (key: PredefinedLakehouseQueryKey) => {
      const entry = PREDEFINED_LAKEHOUSE_QUERIES[key]
      if (!entry) return
      setSqlQuery(entry.query)
      runQuery(entry.query, true)
    },
    [runQuery]
  )

  const handleSqlChange = useCallback((value: string | undefined) => {
    setSqlQuery(value ?? "")
    setManualQueryError(null)
    pendingScrollRef.current = false
  }, [])

  const handleRefresh = useCallback(() => void credentialsQuery.refetch(), [credentialsQuery])

  const getLatestSchemas = useCallback(() => ({ tableSchemas: tables }), [tables])

  // ── Auto-fix query when referenced table is no longer loaded ──────────────
  const getFallbackQuery = useCallback((): string => {
    if (hasUsage && hasMetadata) return PREDEFINED_LAKEHOUSE_QUERIES.allUsage.query
    if (hasUsage) return PREDEFINED_LAKEHOUSE_QUERIES.usageByFeature.query
    if (hasVerification) return PREDEFINED_LAKEHOUSE_QUERIES.verificationByFeature.query
    if (hasMetadata) return PREDEFINED_LAKEHOUSE_QUERIES.metadataRaw.query
    if (hasEntitlementSnapshots) return PREDEFINED_LAKEHOUSE_QUERIES.entitlementSnapshotsRaw.query
    return ""
  }, [hasUsage, hasMetadata, hasVerification, hasEntitlementSnapshots])

  useEffect(() => {
    if (!tableReady) return
    const missing = getRequiredTables(sqlQuery).filter((t) => !loadedTables.includes(t))
    if (missing.length > 0) {
      const fallback = getFallbackQuery()
      if (fallback && fallback !== sqlQuery) {
        setSqlQuery(fallback)
        setExecutedQuery(null)
      }
    }
  }, [tableReady, loadedTables, sqlQuery, getFallbackQuery])

  // ── Scroll to results after a query is dispatched ────────────────────────
  useEffect(() => {
    if (!pendingScrollRef.current || !executedQuery) return
    const id = requestAnimationFrame(() => {
      ;(resultsRef.current ?? sqlShellRef.current)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
      pendingScrollRef.current = false
    })
    return () => cancelAnimationFrame(id)
  }, [executedQuery])

  // ── Predefined query option list ──────────────────────────────────────────
  const predefinedQueryOptions = useMemo(
    () =>
      Object.entries(PREDEFINED_LAKEHOUSE_QUERIES).map(([key, value]) => ({
        key: key as PredefinedLakehouseQueryKey,
        label: value.label,
        disabled: getRequiredTables(value.query).some((t) => !loadedTables.includes(t)),
      })),
    [loadedTables]
  )

  const quickQueries = useMemo(
    () =>
      QUICK_QUERY_KEYS.map((k) => predefinedQueryOptions.find((o) => o.key === k)).filter(
        (o): o is (typeof predefinedQueryOptions)[number] => Boolean(o)
      ),
    [predefinedQueryOptions]
  )

  const missingTablesForQuery = useMemo(
    () => getRequiredTables(sqlQuery).filter((t) => !loadedTables.includes(t)),
    [sqlQuery, loadedTables]
  )

  // ── Status badge ──────────────────────────────────────────────────────────
  const snapshotStatus = useMemo(() => {
    if (error) return SNAPSHOT_STATUS.error
    if (isLoading) return SNAPSHOT_STATUS.loading
    if (!tableReady) return SNAPSHOT_STATUS.idle
    return SNAPSHOT_STATUS.ready
  }, [error, isLoading, tableReady])

  const lastSyncedLabel = useMemo(
    () =>
      credentialsQuery.dataUpdatedAt
        ? new Date(credentialsQuery.dataUpdatedAt).toLocaleString()
        : "—",
    [credentialsQuery.dataUpdatedAt]
  )

  // ── Download CSV ──────────────────────────────────────────────────────────
  const downloadTable = useCallback(() => {
    if (queryResult?.arrowTable) downloadArrowTableAsCsv(queryResult.arrowTable)
  }, [queryResult?.arrowTable])

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="w-full min-w-0 space-y-6">
      {/* ── Header bar ───────────────────────────────────────────────────── */}
      <motion.div
        {...SECTION_MOTION}
        className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-lg tracking-tight">Lakehouse Snapshot</h3>

            <div className="flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs shadow-sm">
              <span className="relative flex h-2 w-2">
                {snapshotStatus.pulse && (
                  <span
                    className={cn(
                      "absolute inline-flex h-full w-full animate-ping rounded-full",
                      snapshotStatus.pulseTone
                    )}
                  />
                )}
                <span
                  className={cn(
                    "relative inline-flex h-2 w-2 rounded-full",
                    snapshotStatus.dotTone
                  )}
                />
              </span>
              <span className={cn("font-medium", snapshotStatus.tone)}>{snapshotStatus.label}</span>
            </div>

            <Badge variant="outline" className="font-mono text-[11px]">
              Last sync {lastSyncedLabel}
            </Badge>
          </div>

          <p className="text-muted-foreground text-sm">
            Historical analytics synced from the data lake. Expected lag: {EXPECTED_LAG_MINUTES}.
          </p>
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={handleRefresh}
          disabled={isLoading}
          title="Refresh snapshot"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </Button>
      </motion.div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 pt-6">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <p className="text-destructive text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* ── Loading card ─────────────────────────────────────────────────── */}
      {isLoading && (
        <Card className="w-full">
          <CardContent className="flex items-center gap-3 py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <p className="font-medium">Syncing lakehouse snapshot...</p>
              <p className="text-muted-foreground text-sm">
                {credentialsQuery.isLoading
                  ? "Fetching file plan from the lakehouse service."
                  : loadingStep || "Importing parquet files."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {isEmpty && (
        <Card className="w-full border-dashed">
          <CardHeader>
            <CardTitle>No lakehouse data yet</CardTitle>
            <CardDescription>
              We could not load usage, verification, or metadata tables from the latest snapshot.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-muted-foreground text-sm">
            <p>When events arrive, KPIs and trend charts will populate automatically.</p>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              Retry load
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Main content (only when tables are ready) ─────────────────────── */}
      {tableReady && (
        <>
          {/* KPI cards */}
          <motion.section {...SECTION_MOTION}>
            <div className="grid gap-4 lg:grid-cols-3">
              {/* Usage volume */}
              <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="font-medium text-sm">Usage volume</CardTitle>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="font-bold text-2xl">
                    {hasUsage ? <NumberTicker value={usageTotal} /> : "—"}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {hasUsage
                      ? `${numberFmt.format(usageEvents)} events · ${numberFmt.format(
                          Number(usageSummaryRow?.customers ?? 0)
                        )} customers`
                      : "Usage table unavailable"}
                  </p>
                </CardContent>
              </Card>

              {/* Verification pass rate */}
              <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="font-medium text-sm">Verification pass rate</CardTitle>
                  <ShieldCheck className="h-4 w-4 text-emerald-500" />
                </CardHeader>
                <CardContent>
                  <div className="font-bold text-2xl">
                    {hasVerification && verificationPassRate !== null ? (
                      <>
                        <NumberTicker
                          value={verificationPassRate}
                          decimalPlaces={1}
                          withFormatter={false}
                        />
                        %
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {hasVerification
                      ? `${numberFmt.format(verificationAllowed)} allowed · ${numberFmt.format(
                          verificationDenied
                        )} denied`
                      : "Verification table unavailable"}
                  </p>
                </CardContent>
              </Card>

              {/* Metadata coverage */}
              <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="font-medium text-sm">Metadata coverage</CardTitle>
                  <Database className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="font-bold text-2xl">
                    {hasUsage && hasMetadata ? (
                      <>
                        <NumberTicker
                          value={metadataCoveragePct ?? 0}
                          decimalPlaces={1}
                          withFormatter={false}
                        />
                        %
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {hasUsage && hasMetadata
                      ? `${numberFmt.format(metadataTagged)} rows with tags · ${numberFmt.format(
                          metadataTotal
                        )} total`
                      : "Metadata table unavailable"}
                  </p>
                </CardContent>
              </Card>
            </div>
          </motion.section>

          {/* Trend charts */}
          <motion.section {...SECTION_MOTION}>
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Usage trend */}
              <Card className="border-muted/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Usage Trend</CardTitle>
                  <CardDescription>
                    Events and usage volume over historical snapshots
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-56">
                  {hasUsage ? (
                    <ChartContainer
                      config={USAGE_TREND_CHART_CONFIG}
                      className="aspect-auto h-56 w-full"
                    >
                      <ComposedChart data={usageTrendData}>
                        <defs>
                          <linearGradient id="usageAreaFill" x1="0" y1="0" x2="0" y2="1">
                            <stop
                              offset="5%"
                              stopColor="var(--color-total_usage)"
                              stopOpacity={0.28}
                            />
                            <stop
                              offset="95%"
                              stopColor="var(--color-total_usage)"
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="hsl(var(--muted-foreground) / 0.2)"
                        />
                        <XAxis
                          dataKey="minute"
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v) => formatMinuteTick(v, usageMinuteSameDay)}
                        />
                        <YAxis tick={{ fontSize: 11 }} />
                        <ChartTooltip
                          cursor={false}
                          content={<ChartTooltipContent indicator="dot" />}
                        />
                        <Area
                          type="monotone"
                          dataKey="total_usage"
                          stroke="var(--color-total_usage)"
                          fill="url(#usageAreaFill)"
                          strokeWidth={2}
                          isAnimationActive
                          animationDuration={900}
                        />
                        <Line
                          type="monotone"
                          dataKey="events"
                          stroke="var(--color-events)"
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive
                          animationDuration={700}
                        />
                      </ComposedChart>
                    </ChartContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                      No usage data yet
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Verification outcomes */}
              <Card className="border-muted/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Verification Outcomes</CardTitle>
                  <CardDescription>Allowed versus denied checks by snapshot minute</CardDescription>
                </CardHeader>
                <CardContent className="h-56">
                  {hasVerification ? (
                    <ChartContainer
                      config={VERIFICATION_TREND_CHART_CONFIG}
                      className="aspect-auto h-56 w-full"
                    >
                      <BarChart data={verificationTrendData}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="hsl(var(--muted-foreground) / 0.2)"
                        />
                        <XAxis
                          dataKey="minute"
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v) => formatMinuteTick(v, verificationMinuteSameDay)}
                        />
                        <YAxis tick={{ fontSize: 11 }} />
                        <ChartTooltip
                          cursor={false}
                          content={<ChartTooltipContent indicator="dot" />}
                        />
                        <Bar dataKey="allowed" stackId="a" fill="var(--color-allowed)" />
                        <Bar dataKey="denied" stackId="a" fill="var(--color-denied)" />
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                      No verification data yet
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </motion.section>

          {/* SQL query lab */}
          <motion.section {...SECTION_MOTION} ref={sqlShellRef}>
            <Card className="w-full">
              <CardHeader>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle>Advanced Query Lab</CardTitle>
                    <CardDescription>
                      Run custom SQL when you need deeper historical inspection.
                    </CardDescription>
                  </div>

                  {/* Predefined query selector */}
                  <Select
                    value=""
                    onValueChange={(key: string) => {
                      const entry = PREDEFINED_LAKEHOUSE_QUERIES[key as PredefinedLakehouseQueryKey]
                      if (entry) {
                        setSqlQuery(entry.query)
                        setManualQueryError(null)
                      }
                    }}
                  >
                    <SelectTrigger className="w-[220px]">
                      <SelectValue placeholder="Load predefined query..." />
                    </SelectTrigger>
                    <SelectContent>
                      {predefinedQueryOptions.map((opt) => (
                        <SelectItem key={opt.key} value={opt.key} disabled={opt.disabled}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Quick-run buttons */}
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mr-1 text-muted-foreground text-xs">Quick runs:</p>
                  {quickQueries.map((opt) => (
                    <Button
                      key={opt.key}
                      variant="outline"
                      size="sm"
                      onClick={() => handleApplyQuery(opt.key)}
                      disabled={opt.disabled || showQueryLoading}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>

                {/* Monaco editor */}
                <div className="overflow-hidden rounded-md border">
                  <SqlMonacoEditor
                    value={sqlQuery}
                    onChange={handleSqlChange}
                    height="200px"
                    tableSchemas={tables}
                    getLatestSchemas={getLatestSchemas}
                  />
                </div>

                {/* Execute / download row */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={handleExecuteQuery}
                    disabled={
                      !tableReady ||
                      showQueryLoading ||
                      !sqlQuery.trim() ||
                      missingTablesForQuery.length > 0
                    }
                  >
                    {showQueryLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    {showQueryLoading ? "Running..." : "Execute SQL"}
                  </Button>

                  {/* Inline validation messages */}
                  {manualQueryError && (
                    <p className="text-destructive text-sm">Query error: {manualQueryError}</p>
                  )}
                  {!manualQueryError && queryError && (
                    <p className="text-destructive text-sm">Query error: {queryError.message}</p>
                  )}
                  {!manualQueryError && !queryError && missingTablesForQuery.length > 0 && (
                    <p className="text-muted-foreground text-sm">
                      Missing table(s): {missingTablesForQuery.join(", ")}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.section>
        </>
      )}

      {/* ── Query results ─────────────────────────────────────────────────── */}
      {executedQuery && (
        <motion.div {...SECTION_MOTION} ref={resultsRef}>
          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>Query Results</CardTitle>
                  <CardDescription>
                    {queryResult
                      ? `${queryResult.arrowTable?.numRows ?? 0} rows returned`
                      : showQueryLoading
                        ? "Running query..."
                        : "No results"}
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadTable}
                  disabled={!queryResult?.arrowTable}
                >
                  <ArrowDownToLine className="mr-2 h-4 w-4" />
                  Download CSV
                </Button>
              </div>
            </CardHeader>

            <CardContent className="overflow-hidden p-0">
              {showQueryLoading ? (
                <div className="space-y-2 p-6">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : queryResult?.arrowTable ? (
                <div className="max-h-[500px] w-full overflow-auto">
                  <DataTableArrowPaginated
                    table={queryResult.arrowTable}
                    pageSize={50}
                    className="min-w-full"
                  />
                </div>
              ) : (
                <p className="p-6 text-muted-foreground text-sm">Execute a query to see results</p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  )
}

// ─── Outer shell (SSR guard + RoomShell context) ──────────────────────────────

export function LakehouseDashboardSqlrooms() {
  const mounted = useMounted()

  if (!mounted) {
    return (
      <div className="w-full min-w-0 space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-2xl tracking-tight">Lakehouse SQL Explorer</h2>
            <p className="text-muted-foreground text-sm">Loading...</p>
          </div>
        </div>
        <Card className="w-full">
          <CardContent className="flex items-center gap-3 py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <p className="font-medium">Initializing database...</p>
              <p className="text-muted-foreground text-sm">
                Setting up the in-browser database engine
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <RoomShell roomStore={roomStore}>
      <LakehouseDashboardInner />
    </RoomShell>
  )
}
