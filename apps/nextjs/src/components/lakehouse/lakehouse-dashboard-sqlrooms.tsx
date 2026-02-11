"use client"

import { DataTableArrowPaginated } from "@sqlrooms/data-table"
import { useSql } from "@sqlrooms/duckdb"
import { RoomShell } from "@sqlrooms/room-shell"
import { SqlMonacoEditor } from "@sqlrooms/sql-editor"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Skeleton } from "@unprice/ui/skeleton"
import {
  AlertCircle,
  ArrowDownToLine,
  BadgeCheck,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useTRPC } from "~/trpc/client"
import { roomStore, useRoomStore } from "./sqlrooms-store"

// Client-side only check to avoid hydration issues
function useIsMounted() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}

// ============================================================================
// Types
// ============================================================================

interface ManifestFile {
  url: string
  key: string
  day: string
  type: "raw" | "compact" | "metadata"
  source?: "usage" | "verification" | "metadata"
  count: number
  bytes: number
  etag?: string
}

// ============================================================================
// Predefined Queries
// ============================================================================

const PREDEFINED_QUERIES = {
  allUsage: {
    label: "Usage (raw + tags)",
    description: "All usage events with metadata tags",
    query: `WITH metadata_dedup AS (
  SELECT
    CAST(meta_id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(tags) AS tags
  FROM metadata
  GROUP BY 1, 2, 3
)
SELECT
  u.*,
  m.tags as metadata_tags
FROM usage u
LEFT JOIN metadata_dedup m
  ON CAST(u.meta_id AS VARCHAR) = m.meta_id
  AND u.project_id = m.project_id
  AND u.customer_id = m.customer_id
WHERE u.deleted = 0
LIMIT 500`,
  },
  usageByFeature: {
    label: "Usage by Feature",
    description: "Aggregate usage grouped by feature",
    query: `SELECT
  u.feature_slug,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.customer_id) as unique_customers,
  MIN(u.timestamp) as first_event,
  MAX(u.timestamp) as last_event
FROM usage u
WHERE u.deleted = 0
GROUP BY u.feature_slug
ORDER BY total_usage DESC`,
  },
  usageByCustomer: {
    label: "Usage by Customer",
    description: "Aggregate usage grouped by customer",
    query: `SELECT
  u.customer_id,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.feature_slug) as features_used,
  MIN(u.timestamp) as first_event,
  MAX(u.timestamp) as last_event
FROM usage u
WHERE u.deleted = 0
GROUP BY u.customer_id
ORDER BY total_usage DESC`,
  },
  usageByRegion: {
    label: "Usage by Region",
    description: "Aggregate usage grouped by region/geography",
    query: `SELECT
  u.region,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.customer_id) as unique_customers,
  COUNT(DISTINCT u.feature_slug) as features_used
FROM usage u
WHERE u.deleted = 0
GROUP BY u.region
ORDER BY total_usage DESC`,
  },
  verificationByFeature: {
    label: "Verification Deny Rate by Feature",
    description: "Where users get blocked most",
    query: `SELECT
  v.feature_slug,
  COUNT(*) as total_checks,
  SUM(CASE WHEN v.allowed = 0 THEN 1 ELSE 0 END) as denied,
  ROUND(SUM(CASE WHEN v.allowed = 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) as deny_rate_pct,
  AVG(v.latency) as avg_latency
FROM verifications v
GROUP BY v.feature_slug
ORDER BY deny_rate_pct DESC`,
  },
  deniedCustomers: {
    label: "Customers Impacted by Denials",
    description: "Accounts with the most denied checks",
    query: `SELECT
  v.customer_id,
  COUNT(*) as denied_events,
  COUNT(DISTINCT v.feature_slug) as affected_features,
  MIN(v.timestamp) as first_denial,
  MAX(v.timestamp) as last_denial
FROM verifications v
WHERE v.allowed = 0
GROUP BY v.customer_id
ORDER BY denied_events DESC
LIMIT 200`,
  },
  verificationLatency: {
    label: "Verification Latency by Feature",
    description: "Which features are slow to verify",
    query: `SELECT
  v.feature_slug,
  AVG(v.latency) as avg_latency,
  MAX(v.latency) as max_latency,
  COUNT(*) as total_checks
FROM verifications v
GROUP BY v.feature_slug
ORDER BY avg_latency DESC`,
  },
  usageByTagKey: {
    label: "Usage by Tag Key",
    description: "Which metadata tags show up most",
    query: `WITH metadata_dedup AS (
  SELECT
    CAST(meta_id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(tags) AS tags
  FROM metadata
  GROUP BY 1, 2, 3
),
joined AS (
  SELECT u.id, m.tags
  FROM usage u
  LEFT JOIN metadata_dedup m
    ON CAST(u.meta_id AS VARCHAR) = m.meta_id
    AND u.project_id = m.project_id
    AND u.customer_id = m.customer_id
  WHERE u.deleted = 0 AND m.tags IS NOT NULL
),
tags AS (
  SELECT unnest(json_keys(tags)) AS tag
  FROM joined
)
SELECT tag, COUNT(*) AS events
FROM tags
WHERE tag NOT IN ('cost', 'rate', 'rate_amount', 'rate_currency', 'rate_unit_size', 'usage', 'remaining')
GROUP BY tag
ORDER BY events DESC`,
  },
  metadataRaw: {
    label: "Metadata (raw)",
    description: "Raw metadata records with tags",
    query: `SELECT
  meta_id,
  tags,
  timestamp
FROM metadata
ORDER BY timestamp DESC
LIMIT 200`,
  },
} as const

type QueryKey = keyof typeof PREDEFINED_QUERIES

const DEFAULT_QUERY = PREDEFINED_QUERIES.allUsage.query

// Table configurations for each data source
const TABLE_CONFIG = {
  usage: { tableName: "usage", label: "Usage Events" },
  verification: { tableName: "verifications", label: "Verifications" },
  metadata: { tableName: "metadata", label: "Metadata" },
} as const

const usageTrendChartConfig = {
  events: { label: "Events", color: "var(--chart-2)" },
  total_usage: { label: "Usage", color: "var(--chart-4)" },
} satisfies ChartConfig

const verificationTrendChartConfig = {
  allowed: { label: "Allowed", color: "var(--chart-4)" },
  denied: { label: "Denied", color: "var(--chart-1)" },
} satisfies ChartConfig

const tagsChartConfig = {
  events: { label: "Events", color: "var(--chart-3)" },
} satisfies ChartConfig

type TableSource = keyof typeof TABLE_CONFIG

// ============================================================================
// Inner Dashboard Component (uses store context)
// ============================================================================

function LakehouseDashboardInner() {
  const trpc = useTRPC()
  const [interval] = useIntervalFilter()
  const [sqlQuery, setSqlQuery] = useState<string>(DEFAULT_QUERY)
  const [executedQuery, setExecutedQuery] = useState<string | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [manualQueryError, setManualQueryError] = useState<string | null>(null)
  const [loadedFileCount, setLoadedFileCount] = useState(0)
  const [loadedTables, setLoadedTables] = useState<string[]>([])
  const loadedManifestFingerprintRef = useRef<string | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const sqlShellRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRef = useRef(false)

  const hasUsage = loadedTables.includes("usage")
  const hasVerification = loadedTables.includes("verifications")
  const hasMetadata = loadedTables.includes("metadata")

  const requiredTables = useCallback((query: string) => {
    const lowered = query.toLowerCase()
    const required: Array<"usage" | "verifications" | "metadata"> = []
    if (/\busage\b/.test(lowered)) required.push("usage")
    if (/\bverifications\b/.test(lowered)) required.push("verifications")
    if (/\bmetadata\b/.test(lowered)) required.push("metadata")
    return required
  }, [])

  // Get store actions and state
  const getConnector = useRoomStore((state) => state.db.getConnector)
  const refreshTableSchemas = useRoomStore((state) => state.db.refreshTableSchemas)
  const tables = useRoomStore((state) => state.db.tables)

  // Fetch URLs using tRPC
  const {
    data: urlsData,
    isLoading: isLoadingUrls,
    error: urlsError,
    refetch: refetchUrls,
  } = useQuery(
    trpc.analytics.getLakehouseUrls.queryOptions(
      { interval: interval.name },
      { staleTime: 1000 * 60 * 5 }
    )
  )

  // Load parquet files into DuckDB when URLs change
  const loadDataIntoDb = useCallback(async () => {
    if (!urlsData) return

    setIsLoadingData(true)
    setLoadError(null)

    try {
      const typedUrls = urlsData as unknown as { result: { manifest: { files: ManifestFile[] } } }
      const manifestResult = typedUrls.result?.manifest

      if (!manifestResult?.files?.length) {
        loadedManifestFingerprintRef.current = null
        setLoadedFileCount(0)
        setLoadedTables([])
        setIsLoadingData(false)
        return
      }

      const manifestFingerprint = manifestResult.files
        .map((file) => `${file.source ?? "usage"}|${file.key}|${file.etag ?? ""}|${file.bytes}`)
        .sort()
        .join("\n")
      if (
        loadedManifestFingerprintRef.current === manifestFingerprint &&
        loadedTables.length > 0 &&
        loadedFileCount > 0
      ) {
        setIsLoadingData(false)
        return
      }

      const connector = await getConnector()

      // Helper function to build read function with options
      const buildReadFn = (url: string) => {
        const isParquet = url.includes(".parquet")
        if (isParquet) {
          return `read_parquet('${url}')`
        }

        // For NDJSON, add options to handle large integers and schema differences
        // - columns: force meta_id to be string to avoid INT64 overflow
        // - auto_detect: keep true so other columns are still inferred
        return `read_ndjson_auto('${url}', ignore_errors := true, maximum_object_size := 33554432, auto_detect := true)`
      }

      // Helper function to load files for a specific source into a table
      const loadTableFromSource = async (source: TableSource, files: ManifestFile[]) => {
        const config = TABLE_CONFIG[source]
        const sourceFiles = files.filter((f) => f.source === source)
        if (sourceFiles.length === 0) return false

        try {
          await connector.query(`DROP TABLE IF EXISTS ${config.tableName}`)
        } catch {
          // Table might not exist
        }

        // Load files into DuckDB
        for (let i = 0; i < sourceFiles.length; i++) {
          const file = sourceFiles[i]
          if (!file) continue

          const readExpr = buildReadFn(file.url)
          const sql =
            i === 0
              ? `CREATE TABLE ${config.tableName} AS SELECT * FROM ${readExpr}`
              : `INSERT INTO ${config.tableName} SELECT * FROM ${readExpr}`

          await connector.query(sql)
        }

        return true
      }

      // Load all three table types
      const tablesLoaded: string[] = []
      let totalFiles = 0

      // Load usage events (files without source or with source="usage")
      const usageFiles = manifestResult.files.filter((f) => !f.source || f.source === "usage")
      if (usageFiles.length > 0) {
        // Drop existing table
        try {
          await connector.query("DROP TABLE IF EXISTS usage")
          await connector.query("DROP TABLE IF EXISTS metadata")
          await connector.query("DROP TABLE IF EXISTS verifications")
        } catch {
          // Table might not exist
        }

        for (let i = 0; i < usageFiles.length; i++) {
          const file = usageFiles[i]
          if (!file) continue

          const readExpr = buildReadFn(file.url)
          const sql =
            i === 0
              ? `CREATE TABLE usage AS SELECT * FROM ${readExpr}`
              : `INSERT INTO usage SELECT * FROM ${readExpr}`

          await connector.query(sql)
        }
        tablesLoaded.push("usage")
        totalFiles += usageFiles.length
      }

      // Load verifications
      if (await loadTableFromSource("verification", manifestResult.files)) {
        tablesLoaded.push("verifications")
        totalFiles += manifestResult.files.filter((f) => f.source === "verification").length
      }

      // Load metadata
      if (await loadTableFromSource("metadata", manifestResult.files)) {
        tablesLoaded.push("metadata")
        totalFiles += manifestResult.files.filter((f) => f.source === "metadata").length
      }

      await refreshTableSchemas()
      loadedManifestFingerprintRef.current = manifestFingerprint
      setLoadedFileCount(totalFiles)
      setLoadedTables(tablesLoaded)

      // Auto-execute default query after loading if we have usage
      if (tablesLoaded.includes("usage")) {
        setSqlQuery(DEFAULT_QUERY)
        setExecutedQuery(DEFAULT_QUERY)
      } else if (tablesLoaded.includes("verifications")) {
        setSqlQuery(PREDEFINED_QUERIES.verificationByFeature.query)
      } else if (tablesLoaded.includes("metadata")) {
        setSqlQuery(PREDEFINED_QUERIES.metadataRaw.query)
      } else {
        setSqlQuery("")
      }
    } catch (err) {
      console.error("[LakehouseDashboardSqlrooms] Load error:", err)
      setLoadError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setIsLoadingData(false)
    }
  }, [urlsData, getConnector, refreshTableSchemas, loadedTables.length, loadedFileCount])

  // Load data when URLs change
  useEffect(() => {
    if (urlsData && !isLoadingUrls) {
      void loadDataIntoDb()
    }
  }, [urlsData, isLoadingUrls, loadDataIntoDb])

  // Reset state when interval changes to force reload
  useEffect(() => {
    loadedManifestFingerprintRef.current = null
    setLoadedTables([])
    setLoadedFileCount(0)
    setExecutedQuery(null)
    setManualQueryError(null)
  }, [interval])

  // Check if any tables are ready
  const tableReady = loadedTables.length > 0

  // Execute the SQL query using useSql hook
  const {
    data: queryResult,
    isLoading: isQueryLoading,
    error: queryError,
  } = useSql({
    query: executedQuery ?? "",
    enabled: !!executedQuery && tableReady,
  })

  // Track execution state - reset isExecuting when query finishes
  useEffect(() => {
    if (!isQueryLoading && isExecuting) {
      setIsExecuting(false)
    }
  }, [isQueryLoading, isExecuting])

  // Handle query execution
  const handleExecuteQuery = useCallback(() => {
    if (sqlQuery.trim()) {
      pendingScrollRef.current = false
      const required = requiredTables(sqlQuery)
      const missing = required.filter((table) => !loadedTables.includes(table))
      if (missing.length > 0) {
        setManualQueryError(`Missing table(s): ${missing.join(", ")}`)
        return
      }
      setManualQueryError(null)
      setIsExecuting(true)
      const runQuery = `${sqlQuery.trim()}\n-- run:${Date.now()}`
      setExecutedQuery(runQuery)
    }
  }, [sqlQuery, requiredTables, loadedTables])

  // Handle refresh
  const handleRefresh = () => {
    void refetchUrls()
  }

  // Handle SQL editor change
  const handleSqlChange = useCallback((value: string | undefined) => {
    setSqlQuery(value ?? "")
    setManualQueryError(null)
    pendingScrollRef.current = false
  }, [])

  // Get latest table schemas for autocomplete
  const getLatestSchemas = useCallback(() => {
    return { tableSchemas: tables }
  }, [tables])

  const isLoading = isLoadingUrls || isLoadingData
  const error = urlsError?.message || loadError
  const showQueryLoading = isExecuting || isQueryLoading
  const isEmpty = !isLoading && !error && !tableReady

  const missingTablesForQuery = useMemo(() => {
    if (!sqlQuery.trim()) return []
    const required = requiredTables(sqlQuery)
    return required.filter((table) => !loadedTables.includes(table))
  }, [sqlQuery, requiredTables, loadedTables])

  const getFallbackQuery = useCallback(() => {
    if (hasUsage) return PREDEFINED_QUERIES.allUsage.query
    if (hasVerification) return PREDEFINED_QUERIES.verificationByFeature.query
    if (hasMetadata) return PREDEFINED_QUERIES.metadataRaw.query
    return ""
  }, [hasUsage, hasVerification, hasMetadata])

  useEffect(() => {
    if (!tableReady) return
    const required = requiredTables(sqlQuery)
    const missing = required.filter((table) => !loadedTables.includes(table))
    if (missing.length > 0) {
      const fallback = getFallbackQuery()
      if (fallback && fallback !== sqlQuery) {
        setSqlQuery(fallback)
        setExecutedQuery(null)
      }
    }
  }, [tableReady, loadedTables, sqlQuery, requiredTables, getFallbackQuery])

  // ============================================================================
  // Analytics Queries (Insights + Visualizations)
  // ============================================================================

  const usageSummaryQuery = `SELECT
  COUNT(*) AS events,
  SUM(usage) AS total_usage,
  COUNT(DISTINCT customer_id) AS customers,
  COUNT(DISTINCT feature_slug) AS features
FROM usage
WHERE deleted = 0`

  const verificationSummaryQuery = `SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) AS allowed,
  SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) AS denied,
  AVG(latency) AS avg_latency
FROM verifications`

  const freshnessQuery = `SELECT
  MAX(timestamp) AS latest_usage_ts
FROM usage
WHERE deleted = 0`

  const verificationFreshnessQuery = `SELECT
  MAX(timestamp) AS latest_verification_ts
FROM verifications`

  const metadataFreshnessQuery = `SELECT
  MAX(timestamp) AS latest_metadata_ts
FROM metadata`

  const metadataCoverageQuery = `WITH metadata_dedup AS (
  SELECT
    CAST(meta_id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(tags) AS tags
  FROM metadata
  GROUP BY 1, 2, 3
),
metadata_user_tags AS (
  SELECT
    meta_id,
    project_id,
    customer_id
  FROM metadata_dedup
  WHERE EXISTS (
    SELECT 1
    FROM unnest(json_keys(tags)) AS t(tag)
    WHERE t.tag NOT IN ('cost', 'rate', 'rate_amount', 'rate_currency', 'rate_unit_size', 'usage', 'remaining')
  )
)
SELECT
  COUNT(DISTINCT u.id) AS total,
  COUNT(DISTINCT CASE WHEN m.meta_id IS NOT NULL THEN u.id END) AS with_meta
FROM usage u
LEFT JOIN metadata_user_tags m
  ON CAST(u.meta_id AS VARCHAR) = m.meta_id
  AND u.project_id = m.project_id
  AND u.customer_id = m.customer_id
WHERE u.deleted = 0`

  const usageTrendQuery = `WITH base AS (
  SELECT
    CASE
      WHEN "timestamp" > 1000000000000 THEN epoch_ms("timestamp")
      ELSE to_timestamp("timestamp")
    END AS ts,
    usage
  FROM usage
  WHERE deleted = 0
)
SELECT
  strftime(CAST(date_trunc('minute', ts) AS TIMESTAMP), '%Y-%m-%d %H:%M') AS minute,
  COUNT(*) AS events,
  SUM(usage) AS total_usage
FROM base
GROUP BY minute
ORDER BY minute`

  const verificationTrendQuery = `WITH base AS (
  SELECT
    CASE
      WHEN "timestamp" > 1000000000000 THEN epoch_ms("timestamp")
      ELSE to_timestamp("timestamp")
    END AS ts,
    allowed
  FROM verifications
)
SELECT
  strftime(CAST(date_trunc('minute', ts) AS TIMESTAMP), '%Y-%m-%d %H:%M') AS minute,
  SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) AS allowed,
  SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) AS denied
FROM base
GROUP BY minute
ORDER BY minute`

  const topTagsQuery = `WITH metadata_dedup AS (
  SELECT
    CAST(meta_id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(tags) AS tags
  FROM metadata
  GROUP BY 1, 2, 3
),
joined AS (
  SELECT u.id, m.tags
  FROM usage u
  LEFT JOIN metadata_dedup m
    ON CAST(u.meta_id AS VARCHAR) = m.meta_id
    AND u.project_id = m.project_id
    AND u.customer_id = m.customer_id
  WHERE u.deleted = 0 AND m.tags IS NOT NULL
),
tags AS (
  SELECT unnest(json_keys(tags)) AS tag
  FROM joined
)
SELECT tag, COUNT(*) AS events
FROM tags
WHERE tag NOT IN ('cost', 'rate', 'rate_amount', 'rate_currency', 'rate_unit_size', 'usage', 'remaining')
GROUP BY tag
ORDER BY events DESC
LIMIT 10`

  const topFeatureQuery = `SELECT
  feature_slug,
  SUM(usage) AS total_usage,
  COUNT(*) AS events
FROM usage
WHERE deleted = 0
GROUP BY feature_slug
ORDER BY total_usage DESC
LIMIT 1`

  const topDeniedReasonQuery = `SELECT
  COALESCE(denied_reason, 'unknown') AS denied_reason,
  COUNT(*) AS denies
FROM verifications
WHERE allowed = 0
GROUP BY denied_reason
ORDER BY denies DESC
LIMIT 1`

  const usageSummary = useSql({ query: usageSummaryQuery, enabled: hasUsage })
  const verificationSummary = useSql({ query: verificationSummaryQuery, enabled: hasVerification })
  const freshness = useSql({ query: freshnessQuery, enabled: hasUsage })
  const verificationFreshness = useSql({
    query: verificationFreshnessQuery,
    enabled: hasVerification,
  })
  const metadataFreshness = useSql({ query: metadataFreshnessQuery, enabled: hasMetadata })
  const metadataCoverage = useSql({
    query: metadataCoverageQuery,
    enabled: hasUsage && hasMetadata,
  })
  const usageTrend = useSql({ query: usageTrendQuery, enabled: hasUsage })
  const verificationTrend = useSql({ query: verificationTrendQuery, enabled: hasVerification })
  const topTags = useSql({ query: topTagsQuery, enabled: hasUsage && hasMetadata })
  const topFeature = useSql({ query: topFeatureQuery, enabled: hasUsage })
  const topDeniedReason = useSql({ query: topDeniedReasonQuery, enabled: hasVerification })

  const numberFmt = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }),
    []
  )

  const percentFmt = useCallback((value: number | null | undefined) => {
    if (value === null || value === undefined || Number.isNaN(value)) return "—"
    return `${value.toFixed(1)}%`
  }, [])

  const formatEpoch = useCallback((value?: number | null) => {
    if (!value) return "—"
    const ms = value > 1_000_000_000_000 ? value : value * 1000
    return new Date(ms).toLocaleString()
  }, [])

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const tableToRows = useCallback((table?: { toArray?: () => any[] } | null) => {
    if (!table?.toArray) return []
    return table.toArray()
  }, [])

  const toNumber = useCallback((value: unknown) => {
    if (typeof value === "bigint") return Number(value)
    if (value === null || value === undefined) return 0
    const num = Number(value)
    return Number.isNaN(num) ? 0 : num
  }, [])

  const usageSummaryRow = useMemo(
    () => tableToRows(usageSummary.data?.arrowTable)[0],
    [usageSummary.data?.arrowTable, tableToRows]
  )
  const verificationSummaryRow = useMemo(
    () => tableToRows(verificationSummary.data?.arrowTable)[0],
    [verificationSummary.data?.arrowTable, tableToRows]
  )
  const freshnessRow = useMemo(
    () => tableToRows(freshness.data?.arrowTable)[0],
    [freshness.data?.arrowTable, tableToRows]
  )
  const verificationFreshnessRow = useMemo(
    () => tableToRows(verificationFreshness.data?.arrowTable)[0],
    [verificationFreshness.data?.arrowTable, tableToRows]
  )
  const metadataFreshnessRow = useMemo(
    () => tableToRows(metadataFreshness.data?.arrowTable)[0],
    [metadataFreshness.data?.arrowTable, tableToRows]
  )
  const metadataCoverageRow = useMemo(
    () => tableToRows(metadataCoverage.data?.arrowTable)[0],
    [metadataCoverage.data?.arrowTable, tableToRows]
  )
  const topFeatureRow = useMemo(
    () => tableToRows(topFeature.data?.arrowTable)[0],
    [topFeature.data?.arrowTable, tableToRows]
  )
  const topDeniedReasonRow = useMemo(
    () => tableToRows(topDeniedReason.data?.arrowTable)[0],
    [topDeniedReason.data?.arrowTable, tableToRows]
  )

  const usageTrendData = useMemo(() => {
    return tableToRows(usageTrend.data?.arrowTable).map((row) => ({
      ...row,
      events: toNumber(row.events),
      total_usage: toNumber(row.total_usage),
    }))
  }, [usageTrend.data?.arrowTable, tableToRows, toNumber])
  const verificationTrendData = useMemo(() => {
    return tableToRows(verificationTrend.data?.arrowTable).map((row) => ({
      ...row,
      allowed: toNumber(row.allowed),
      denied: toNumber(row.denied),
    }))
  }, [verificationTrend.data?.arrowTable, tableToRows, toNumber])
  const topTagsData = useMemo(() => {
    return tableToRows(topTags.data?.arrowTable).map((row) => ({
      ...row,
      events: toNumber(row.events),
    }))
  }, [topTags.data?.arrowTable, tableToRows, toNumber])

  const usageMinuteSameDay = useMemo(() => {
    if (usageTrendData.length < 2) return false
    const first = usageTrendData[0]?.minute
    const last = usageTrendData[usageTrendData.length - 1]?.minute
    if (!first || !last) return false
    return first.slice(0, 10) === last.slice(0, 10)
  }, [usageTrendData])

  const verificationMinuteSameDay = useMemo(() => {
    if (verificationTrendData.length < 2) return false
    const first = verificationTrendData[0]?.minute
    const last = verificationTrendData[verificationTrendData.length - 1]?.minute
    if (!first || !last) return false
    return first.slice(0, 10) === last.slice(0, 10)
  }, [verificationTrendData])

  const formatMinuteTick = useCallback((value: string, sameDay: boolean) => {
    if (!value) return value
    if (sameDay) return value.slice(11, 16) // HH:MM
    return value.slice(5, 16) // MM-DD HH:MM
  }, [])

  const metadataCoveragePct = useMemo(() => {
    if (!hasMetadata) return null
    const total = Number(metadataCoverageRow?.total ?? 0)
    const withMeta = Number(metadataCoverageRow?.with_meta ?? 0)
    if (!total) return 0
    return (withMeta / total) * 100
  }, [metadataCoverageRow, hasMetadata])

  const verificationPassRate = useMemo(() => {
    if (!hasVerification) return null
    const total = Number(verificationSummaryRow?.total ?? 0)
    const allowed = Number(verificationSummaryRow?.allowed ?? 0)
    if (!total) return 0
    return (allowed / total) * 100
  }, [verificationSummaryRow, hasVerification])

  const handleApplyQuery = useCallback(
    (queryKey: QueryKey) => {
      const query = PREDEFINED_QUERIES[queryKey]
      if (!query) return
      const required = requiredTables(query.query)
      const missing = required.filter((table) => !loadedTables.includes(table))
      if (missing.length > 0) {
        setManualQueryError(`Missing table(s): ${missing.join(", ")}`)
        return
      }
      setManualQueryError(null)
      pendingScrollRef.current = true
      setSqlQuery(query.query)
      const runQuery = `${query.query.trim()}\n-- run:${Date.now()}`
      setIsExecuting(true)
      setExecutedQuery(runQuery)
    },
    [setSqlQuery, setExecutedQuery, requiredTables, loadedTables]
  )

  const downloadTable = useCallback(() => {
    if (!queryResult?.arrowTable) return
    const rows = queryResult.arrowTable.toArray()
    const columns = queryResult.arrowTable.schema.fields.map((f) => f.name)

    const escapeCsv = (value: unknown) => {
      if (value === null || value === undefined) return ""
      const str = String(value)
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    }

    const lines = [
      columns.join(","),
      ...rows.map((row: Record<string, unknown>) =>
        columns.map((col) => escapeCsv(row[col])).join(",")
      ),
    ]
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "lakehouse-query.csv"
    a.click()
    URL.revokeObjectURL(url)
  }, [queryResult?.arrowTable])

  useEffect(() => {
    if (!pendingScrollRef.current) return
    if (!executedQuery) return

    const id = requestAnimationFrame(() => {
      if (resultsRef.current) {
        resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" })
        pendingScrollRef.current = false
        return
      }
      if (sqlShellRef.current) {
        sqlShellRef.current.scrollIntoView({ behavior: "smooth", block: "start" })
        pendingScrollRef.current = false
      }
    })

    return () => cancelAnimationFrame(id)
  }, [executedQuery])

  return (
    <div className="w-full min-w-0 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">
            {tableReady
              ? `${loadedFileCount} files loaded into ${loadedTables.length} tables (${loadedTables.join(", ")})`
              : isLoading
                ? "Loading data..."
                : "Waiting for data"}
          </p>
          <div className="flex flex-wrap gap-2 pt-2 text-muted-foreground text-xs">
            <span className="rounded-full border px-2 py-1">
              Usage last update:{" "}
              {hasUsage ? formatEpoch(Number(freshnessRow?.latest_usage_ts ?? 0)) : "No data"}
            </span>
            <span className="rounded-full border px-2 py-1">
              Verification last update:{" "}
              {hasVerification
                ? formatEpoch(Number(verificationFreshnessRow?.latest_verification_ts ?? 0))
                : "No data"}
            </span>
            <span className="rounded-full border px-2 py-1">
              Metadata last update:{" "}
              {hasMetadata
                ? formatEpoch(Number(metadataFreshnessRow?.latest_metadata_ts ?? 0))
                : "No data"}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            disabled={isLoading}
            title="Refresh data"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 pt-6">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <p className="text-destructive text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Loading State */}
      {isLoading && (
        <Card className="w-full">
          <CardContent className="flex items-center gap-3 py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <p className="font-medium">Loading lakehouse data...</p>
              <p className="text-muted-foreground text-sm">
                Fetching and importing data files into database
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {isEmpty && (
        <Card className="w-full border-dashed">
          <CardHeader>
            <CardTitle>No lakehouse data yet</CardTitle>
            <CardDescription>
              We didn&apos;t find any usage, verification, or metadata files for this interval.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-muted-foreground text-sm">
            <p>When events arrive, insights and charts will populate automatically.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                Retry load
              </Button>
              <Button variant="outline" size="sm" disabled>
                Run sample query
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Trust + Health Overview */}
      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="border-muted/60 bg-gradient-to-br from-background to-muted/50">
          <CardHeader className="pb-2">
            <CardTitle className="font-medium text-muted-foreground text-sm">
              Usage Health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="font-semibold text-2xl">
              {hasUsage ? numberFmt.format(Number(usageSummaryRow?.total_usage ?? 0)) : "No data"}
            </p>
            <p className="text-muted-foreground text-xs">
              {hasUsage
                ? `${numberFmt.format(Number(usageSummaryRow?.events ?? 0))} events · ${numberFmt.format(
                    Number(usageSummaryRow?.customers ?? 0)
                  )} customers`
                : "Usage data not synced yet"}
            </p>
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <BadgeCheck className="h-3.5 w-3.5 text-emerald-500" />
              Freshness: {hasUsage ? formatEpoch(Number(freshnessRow?.latest_usage_ts ?? 0)) : "—"}
            </div>
          </CardContent>
        </Card>

        <Card className="border-muted/60 bg-gradient-to-br from-background to-muted/50">
          <CardHeader className="pb-2">
            <CardTitle className="font-medium text-muted-foreground text-sm">
              Verification Trust
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="font-semibold text-2xl">
              {hasVerification ? percentFmt(verificationPassRate) : "No data"}
            </p>
            <p className="text-muted-foreground text-xs">
              {hasVerification
                ? `${numberFmt.format(
                    Number(verificationSummaryRow?.allowed ?? 0)
                  )} allowed · ${numberFmt.format(
                    Number(verificationSummaryRow?.denied ?? 0)
                  )} denied`
                : "Verification data not synced yet"}
            </p>
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              Latest check:{" "}
              {hasVerification
                ? formatEpoch(Number(verificationFreshnessRow?.latest_verification_ts))
                : "—"}
            </div>
          </CardContent>
        </Card>

        <Card className="border-muted/60 bg-gradient-to-br from-background to-muted/50">
          <CardHeader className="pb-2">
            <CardTitle className="font-medium text-muted-foreground text-sm">
              Metadata Coverage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="font-semibold text-2xl">
              {hasUsage && hasMetadata ? percentFmt(metadataCoveragePct) : "No data"}
            </p>
            <p className="text-muted-foreground text-xs">
              {hasUsage && hasMetadata
                ? `${numberFmt.format(
                    Number(metadataCoverageRow?.with_meta ?? 0)
                  )} with tags · ${numberFmt.format(Number(metadataCoverageRow?.total ?? 0))} total`
                : "Metadata not synced yet"}
            </p>
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              Clean data is first-class
            </div>
          </CardContent>
        </Card>

        <Card className="border-muted/60 bg-gradient-to-br from-background to-muted/50">
          <CardHeader className="pb-2">
            <CardTitle className="font-medium text-muted-foreground text-sm">
              Avg Verification Latency
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="font-semibold text-2xl">
              {hasVerification
                ? `${numberFmt.format(Number(verificationSummaryRow?.avg_latency ?? 0))} ms`
                : "No data"}
            </p>
            <p className="text-muted-foreground text-xs">
              {hasVerification
                ? `Across ${numberFmt.format(Number(verificationSummaryRow?.total ?? 0))} checks`
                : "Verification data not synced yet"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Insight → Evidence → Action */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="relative overflow-hidden border-muted/60">
          <CardHeader>
            <CardTitle className="text-base">Usage Momentum</CardTitle>
            <CardDescription>
              Top feature by usage:{" "}
              <span className="font-medium text-foreground">
                {hasUsage ? (topFeatureRow?.feature_slug ?? "—") : "No data"}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {hasUsage
                ? `${numberFmt.format(Number(topFeatureRow?.total_usage ?? 0))} usage · ${numberFmt.format(
                    Number(topFeatureRow?.events ?? 0)
                  )} events`
                : "Usage data not synced yet"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleApplyQuery("usageByFeature")}
                disabled={!hasUsage}
              >
                Show evidence
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-muted/60">
          <CardHeader>
            <CardTitle className="text-base">Verification Risk</CardTitle>
            <CardDescription>
              Top denial reason:{" "}
              <span className="font-medium text-foreground">
                {hasVerification ? (topDeniedReasonRow?.denied_reason ?? "—") : "No data"}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {hasVerification
                ? `${numberFmt.format(Number(topDeniedReasonRow?.denies ?? 0))} denied checks`
                : "Verification data not synced yet"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleApplyQuery("verificationByFeature")}
                disabled={!hasVerification}
              >
                Show evidence
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-muted/60">
          <CardHeader>
            <CardTitle className="text-base">Tag Signal</CardTitle>
            <CardDescription>Metadata tag keys driving usage</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">
              Top tag:{" "}
              <span className="font-medium text-foreground">
                {hasUsage && hasMetadata ? (topTagsData?.[0]?.tag ?? "—") : "No data"}
              </span>
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleApplyQuery("usageByTagKey")}
                disabled={!hasUsage || !hasMetadata}
              >
                Show evidence
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Visualizations */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="border-muted/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Usage Trend</CardTitle>
            <CardDescription>Events + usage volume over time</CardDescription>
          </CardHeader>
          <CardContent className="h-56">
            {hasUsage ? (
              <ChartContainer config={usageTrendChartConfig} className="aspect-auto h-56 w-full">
                <LineChart data={usageTrendData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--muted-foreground) / 0.2)"
                  />
                  <XAxis
                    dataKey="minute"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) => formatMinuteTick(value, usageMinuteSameDay)}
                  />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                  <Line
                    type="monotone"
                    dataKey="events"
                    stroke="var(--color-events)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="total_usage"
                    stroke="var(--color-total_usage)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                No usage data yet
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-muted/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Verification Outcomes</CardTitle>
            <CardDescription>Allowed vs denied checks</CardDescription>
          </CardHeader>
          <CardContent className="h-56">
            {hasVerification ? (
              <ChartContainer
                config={verificationTrendChartConfig}
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
                    tickFormatter={(value) => formatMinuteTick(value, verificationMinuteSameDay)}
                  />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
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

        <Card className="border-muted/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top Metadata Tags</CardTitle>
            <CardDescription>Signals from customer-provided tags</CardDescription>
          </CardHeader>
          <CardContent className="h-56">
            {hasUsage && hasMetadata ? (
              <ChartContainer config={tagsChartConfig} className="aspect-auto h-56 w-full">
                <BarChart data={topTagsData} layout="vertical" margin={{ left: 40 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--muted-foreground) / 0.2)"
                  />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="tag" type="category" width={90} tick={{ fontSize: 11 }} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                  <Bar dataKey="events" fill="var(--color-events)" />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                No metadata tags yet
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* SQL Editor */}
      <div ref={sqlShellRef}>
        <Card className="w-full">
          <CardHeader>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>SQL Query</CardTitle>
                <CardDescription>
                  Write SQL or select a predefined query (Ctrl+Space for autocomplete)
                </CardDescription>
              </div>
              <Select
                value=""
                onValueChange={(key: string) => {
                  const query = PREDEFINED_QUERIES[key as QueryKey]
                  if (query) {
                    setSqlQuery(query.query)
                    setManualQueryError(null)
                  }
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Predefined queries..." />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PREDEFINED_QUERIES).map(([key, { label }]) => {
                    const query = PREDEFINED_QUERIES[key as QueryKey]
                    const required = requiredTables(query.query)
                    const disabled = required.some((table) => !loadedTables.includes(table))
                    return (
                      <SelectItem key={key} value={key} disabled={disabled}>
                        <div className="flex flex-col">
                          <span>{label}</span>
                        </div>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-hidden rounded-md border">
              <SqlMonacoEditor
                value={sqlQuery}
                onChange={handleSqlChange}
                height="200px"
                tableSchemas={tables}
                getLatestSchemas={getLatestSchemas}
              />
            </div>

            <div className="flex items-center gap-2">
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
                {showQueryLoading ? "Running..." : "Execute"}
              </Button>

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
      </div>

      {/* Query Results */}
      {executedQuery && (
        <div ref={resultsRef}>
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
                <div className="flex items-center gap-2">
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
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Main Dashboard Component (wraps with RoomShell)
// ============================================================================

export function LakehouseDashboardSqlrooms() {
  const isMounted = useIsMounted()

  // Prevent SSR/hydration issues with DuckDB WASM and Monaco
  if (!isMounted) {
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
