"use client"

import { DataTableArrowPaginated } from "@sqlrooms/data-table"
import { useSql } from "@sqlrooms/duckdb"
import { RoomShell } from "@sqlrooms/room-shell"
import { useQuery } from "@tanstack/react-query"
import {
  DEFAULT_LAKEHOUSE_QUERY,
  PREDEFINED_LAKEHOUSE_QUERIES,
  type PredefinedLakehouseQueryKey,
} from "@unprice/lakehouse"
import { Badge } from "@unprice/ui/badge"
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
import { type LakehouseFilePlan, roomStore, useRoomStore } from "./sqlrooms-store"

// Table configurations for each data source
const TABLE_CONFIG = {
  usage: { tableName: "usage", label: "Usage Events" },
  verification: {
    tableName: "verifications",
    label: "Verifications",
  },
  metadata: { tableName: "metadata", label: "Metadata" },
  entitlement_snapshot: {
    tableName: "entitlement_snapshots",
    label: "Entitlement Snapshots",
  },
} as const

const usageTrendChartConfig = {
  events: { label: "Events", color: "var(--chart-2)" },
  total_usage: { label: "Usage", color: "var(--chart-4)" },
} satisfies ChartConfig

const verificationTrendChartConfig = {
  allowed: { label: "Allowed", color: "var(--chart-4)" },
  denied: { label: "Denied", color: "var(--chart-1)" },
} satisfies ChartConfig

const CREDENTIAL_REFRESH_BUFFER_MS = 60_000
const EXPECTED_LAG_MINUTES = "5-10 min"
const CACHE_STATE_TABLE = "__lakehouse_cache_state"
const QUICK_QUERY_KEYS: PredefinedLakehouseQueryKey[] = [
  "allUsage",
  "usageByFeature",
  "verificationByFeature",
  "verificationWithMetadata",
  "metadataRaw",
  "usageByTagKey",
]
const SECTION_MOTION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22, ease: "easeOut" },
} as const

const SqlMonacoEditor = dynamic(
  () => import("@sqlrooms/sql-editor").then((module) => module.SqlMonacoEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[200px] items-center justify-center bg-muted/20 text-muted-foreground text-sm">
        Loading SQL editor...
      </div>
    ),
  }
)

type TableSource = keyof typeof TABLE_CONFIG

// ============================================================================
// Inner Dashboard Component (uses store context)
// ============================================================================

function LakehouseDashboardInner() {
  const trpc = useTRPC()
  const [interval] = useIntervalFilter()
  const [sqlQuery, setSqlQuery] = useState<string>(DEFAULT_LAKEHOUSE_QUERY)
  const [executedQuery, setExecutedQuery] = useState<string | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [loadingStep, setLoadingStep] = useState<string>("")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [manualQueryError, setManualQueryError] = useState<string | null>(null)
  const [loadedFileCount, setLoadedFileCount] = useState(0)
  const [loadedTables, setLoadedTables] = useState<string[]>([])
  const loadedCatalogFingerprintRef = useRef<string | null>(null)
  const credentialRefreshRetryRef = useRef(false)
  const loadingStepRef = useRef<string>("")
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const sqlShellRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRef = useRef(false)

  const hasUsage = loadedTables.includes("usage")
  const hasVerification = loadedTables.includes("verifications")
  const hasMetadata = loadedTables.includes("metadata")
  const hasEntitlementSnapshots = loadedTables.includes("entitlement_snapshots")

  const requiredTables = useCallback((query: string) => {
    const lowered = query.toLowerCase()
    const required: Array<"usage" | "verifications" | "metadata" | "entitlement_snapshots"> = []
    if (/\busage\b/.test(lowered)) required.push("usage")
    if (/\bverifications\b/.test(lowered)) required.push("verifications")
    if (/\bmetadata\b/.test(lowered)) required.push("metadata")
    if (/\bentitlement_snapshots\b/.test(lowered)) required.push("entitlement_snapshots")
    return required
  }, [])

  // Get store actions and state
  const getConnector = useRoomStore((state) => state.db.getConnector)
  const refreshTableSchemas = useRoomStore((state) => state.db.refreshTableSchemas)
  const setFilePlan = useRoomStore((state) => state.setFilePlan)
  const tables = useRoomStore((state) => state.db.tables)

  const credentialsQuery = useQuery(
    trpc.analytics.getLakehouseFilePlan.queryOptions(
      { interval: interval.name },
      { staleTime: 1000 * 60 * 5 }
    )
  )

  const isLoadingUrls = credentialsQuery.isLoading
  const urlsError = credentialsQuery.error

  const isCredentialRefreshError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    return /expired|invalid.+token|accessdenied|forbidden|http\s*403|unauthorized/i.test(message)
  }, [])

  const updateLoadingStep = useCallback((step: string) => {
    loadingStepRef.current = step
    setLoadingStep(step)
  }, [])

  const loadDataIntoDb = useCallback(async () => {
    const credentialsResult = credentialsQuery.data
    if (!credentialsResult || credentialsResult.error || !credentialsResult.result) {
      return
    }

    setIsLoadingData(true)
    updateLoadingStep("Connecting to local analytics engine")
    setLoadError(null)

    try {
      const withTimeout = async <T,>(
        task: PromiseLike<T>,
        timeoutMs: number,
        operationLabel: string
      ): Promise<T> => {
        let timeoutId: number | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error(`Timed out while ${operationLabel}.`))
          }, timeoutMs)
        })

        try {
          return (await Promise.race([task, timeoutPromise])) as T
        } finally {
          if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId)
          }
        }
      }

      const filePlan = credentialsResult.result as LakehouseFilePlan
      setFilePlan(filePlan)

      const normalizeFileUrlForFingerprint = (fileUrl: string) => {
        try {
          const parsed = new URL(fileUrl)
          return `${parsed.host}${parsed.pathname}`
        } catch {
          return fileUrl.split("?")[0] ?? fileUrl
        }
      }

      const tableFileFingerprint = (Object.keys(TABLE_CONFIG) as TableSource[])
        .map((source) => {
          const normalizedFiles = [...(filePlan.tableFiles[source] ?? [])]
            .map(normalizeFileUrlForFingerprint)
            .sort()
          return `${source}:${normalizedFiles.join(",")}`
        })
        .join("|")

      const expireToken = filePlan.credentials.expiration ?? ""
      const credentialFingerprint = [
        filePlan.credentials.accessKeyId,
        filePlan.credentials.sessionToken,
        String(expireToken),
      ].join("|")
      const catalogFingerprint = [
        filePlan.targetEnv,
        filePlan.interval,
        credentialFingerprint,
        tableFileFingerprint,
      ].join("|")

      if (
        loadedCatalogFingerprintRef.current === catalogFingerprint &&
        loadedTables.length > 0 &&
        loadedFileCount > 0
      ) {
        setIsLoadingData(false)
        updateLoadingStep("")
        return
      }

      const connector = await withTimeout(getConnector(), 20_000, "initializing local DuckDB")

      const escapeSqlString = (value: string) => value.replaceAll("'", "''")
      const rowArrayFromResult = (result: unknown): Array<Record<string, unknown>> => {
        return (result as { toArray?: () => Array<Record<string, unknown>> })?.toArray?.() ?? []
      }

      const applySnapshotSelection = (tablesLoaded: string[]) => {
        if (tablesLoaded.includes("usage")) {
          const initialQuery = tablesLoaded.includes("metadata")
            ? PREDEFINED_LAKEHOUSE_QUERIES.allUsage.query
            : PREDEFINED_LAKEHOUSE_QUERIES.usageByFeature.query
          setSqlQuery(initialQuery)
          return
        }

        if (tablesLoaded.includes("verifications")) {
          setSqlQuery(PREDEFINED_LAKEHOUSE_QUERIES.verificationByFeature.query)
          return
        }

        if (tablesLoaded.includes("metadata")) {
          setSqlQuery(PREDEFINED_LAKEHOUSE_QUERIES.metadataRaw.query)
          return
        }

        if (tablesLoaded.includes("entitlement_snapshots")) {
          setSqlQuery(PREDEFINED_LAKEHOUSE_QUERIES.entitlementSnapshotsRaw.query)
          return
        }

        setSqlQuery("")
      }

      const applySnapshotState = (tablesLoaded: string[], totalFiles: number) => {
        loadedCatalogFingerprintRef.current = catalogFingerprint
        credentialRefreshRetryRef.current = false
        setLoadedFileCount(totalFiles)
        setLoadedTables(tablesLoaded)
        applySnapshotSelection(tablesLoaded)
      }

      const ensureCacheStateTable = async () => {
        await withTimeout(
          connector.query(`CREATE TABLE IF NOT EXISTS ${CACHE_STATE_TABLE} (
  state_key VARCHAR PRIMARY KEY,
  catalog_fingerprint VARCHAR,
  tables_json VARCHAR,
  loaded_file_count BIGINT,
  updated_at TIMESTAMP
)`),
          20_000,
          "preparing snapshot cache state"
        )
      }

      const readSnapshotCacheState = async () => {
        await ensureCacheStateTable()
        const result = await withTimeout(
          connector.query(`SELECT
  catalog_fingerprint,
  tables_json,
  loaded_file_count
FROM ${CACHE_STATE_TABLE}
WHERE state_key = 'latest'
LIMIT 1`),
          20_000,
          "reading snapshot cache state"
        )
        const row = rowArrayFromResult(result)[0]
        if (!row || typeof row.catalog_fingerprint !== "string") {
          return null
        }

        const parsedTables = (() => {
          if (typeof row.tables_json !== "string") return []
          try {
            const parsed = JSON.parse(row.tables_json)
            return Array.isArray(parsed)
              ? parsed.filter((value): value is string => typeof value === "string")
              : []
          } catch {
            return []
          }
        })()

        return {
          catalogFingerprint: row.catalog_fingerprint,
          tables: parsedTables,
          loadedFileCount: Number(row.loaded_file_count ?? 0),
        }
      }

      const getExistingTableNames = async () => {
        const result = await withTimeout(
          connector.query(`SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema()`),
          20_000,
          "checking cached tables"
        )

        return new Set(
          rowArrayFromResult(result)
            .map((row) => String(row.table_name ?? ""))
            .filter(Boolean)
        )
      }

      const persistSnapshotCacheState = async (tablesLoaded: string[], totalFiles: number) => {
        await ensureCacheStateTable()
        await withTimeout(
          connector.query(`DELETE FROM ${CACHE_STATE_TABLE} WHERE state_key = 'latest'`),
          20_000,
          "resetting snapshot cache state"
        )
        await withTimeout(
          connector.query(`INSERT INTO ${CACHE_STATE_TABLE} (
  state_key,
  catalog_fingerprint,
  tables_json,
  loaded_file_count,
  updated_at
) VALUES (
  'latest',
  '${escapeSqlString(catalogFingerprint)}',
  '${escapeSqlString(JSON.stringify(tablesLoaded))}',
  ${totalFiles},
  current_timestamp
)`),
          20_000,
          "saving snapshot cache state"
        )
      }

      const cachedState = await readSnapshotCacheState()
      if (cachedState?.catalogFingerprint === catalogFingerprint) {
        const existingTableNames = await getExistingTableNames()
        const cachedTables = cachedState.tables.filter((table) => existingTableNames.has(table))
        if (cachedTables.length > 0) {
          updateLoadingStep("Using cached lakehouse snapshot")
          updateLoadingStep("Refreshing table schemas")
          await withTimeout(refreshTableSchemas(), 20_000, "refreshing table schemas")
          applySnapshotState(
            cachedTables,
            Math.max(cachedState.loadedFileCount, cachedTables.length)
          )
          updateLoadingStep("Snapshot synced")
          return
        }
      }

      const endpointHost = (() => {
        try {
          return new URL(filePlan.credentials.r2Endpoint).host
        } catch {
          return filePlan.credentials.r2Endpoint.replace(/^https?:\/\//, "")
        }
      })()

      updateLoadingStep("Loading HTTP file extension")
      try {
        await withTimeout(
          connector.query("INSTALL httpfs"),
          20_000,
          "installing DuckDB httpfs extension"
        )
      } catch (installError) {
        console.warn("[LakehouseDashboardSqlrooms] INSTALL httpfs skipped:", installError)
      }

      await withTimeout(connector.query("LOAD httpfs"), 20_000, "loading DuckDB httpfs extension")

      updateLoadingStep("Applying temporary lakehouse credentials")
      await withTimeout(
        connector.query(`CREATE OR REPLACE SECRET lakehouse_r2_secret (
  TYPE S3,
  KEY_ID '${escapeSqlString(filePlan.credentials.accessKeyId)}',
  SECRET '${escapeSqlString(filePlan.credentials.secretAccessKey)}',
  SESSION_TOKEN '${escapeSqlString(filePlan.credentials.sessionToken)}',
  ENDPOINT '${escapeSqlString(endpointHost)}',
  URL_STYLE 'path',
  REGION 'auto'
)`),
        20_000,
        "creating temporary R2 secret"
      )

      const createReadParquetExpression = (fileUrls: string[]) => {
        const escapedPaths = fileUrls.map((fileUrl) => `'${escapeSqlString(fileUrl)}'`).join(", ")
        return `read_parquet([${escapedPaths}], union_by_name = true)`
      }

      const loadTableFromSource = async (source: TableSource) => {
        const config = TABLE_CONFIG[source]
        const tableFiles = filePlan.tableFiles[source] ?? []

        if (tableFiles.length === 0) {
          await withTimeout(
            connector.query(`DROP TABLE IF EXISTS ${config.tableName}`),
            20_000,
            `clearing ${config.label.toLowerCase()}`
          )
          return 0
        }

        const plural = tableFiles.length === 1 ? "file" : "files"
        updateLoadingStep(`Importing ${config.label} (${tableFiles.length} ${plural})`)

        const parquetSource = createReadParquetExpression(tableFiles)
        const sourceSelect =
          source === "verification"
            ? `SELECT * REPLACE (CAST(denied_reason AS VARCHAR) AS denied_reason)
FROM ${parquetSource}`
            : `SELECT * FROM ${parquetSource}`

        await withTimeout(
          connector.query(`CREATE OR REPLACE TABLE ${config.tableName} AS ${sourceSelect}`),
          240_000,
          `importing ${config.label.toLowerCase()}`
        )
        return tableFiles.length
      }

      const tablesLoaded: string[] = []
      let totalFiles = 0

      const usageFiles = await loadTableFromSource("usage")
      if (usageFiles > 0) {
        tablesLoaded.push("usage")
        totalFiles += usageFiles
      }

      const verificationFiles = await loadTableFromSource("verification")
      if (verificationFiles > 0) {
        tablesLoaded.push("verifications")
        totalFiles += verificationFiles
      }

      const metadataFiles = await loadTableFromSource("metadata")
      if (metadataFiles > 0) {
        tablesLoaded.push("metadata")
        totalFiles += metadataFiles
      }

      const entitlementSnapshotFiles = await loadTableFromSource("entitlement_snapshot")
      if (entitlementSnapshotFiles > 0) {
        tablesLoaded.push("entitlement_snapshots")
        totalFiles += entitlementSnapshotFiles
      }

      updateLoadingStep("Refreshing table schemas")
      await withTimeout(refreshTableSchemas(), 20_000, "refreshing table schemas")
      applySnapshotState(tablesLoaded, totalFiles)
      await persistSnapshotCacheState(tablesLoaded, totalFiles)
      updateLoadingStep("Snapshot synced")
    } catch (err) {
      console.error("[LakehouseDashboardSqlrooms] Load error:", err)

      if (isCredentialRefreshError(err) && !credentialRefreshRetryRef.current) {
        credentialRefreshRetryRef.current = true
        loadedCatalogFingerprintRef.current = null
        void credentialsQuery.refetch()
        return
      }

      credentialRefreshRetryRef.current = false
      const stepPrefix = loadingStepRef.current ? `${loadingStepRef.current}: ` : ""
      const fallbackMessage = err instanceof Error ? err.message : "Failed to load data"
      setLoadError(`${stepPrefix}${fallbackMessage}`)
    } finally {
      setIsLoadingData(false)
      updateLoadingStep("")
    }
  }, [
    credentialsQuery.data,
    credentialsQuery.refetch,
    getConnector,
    isCredentialRefreshError,
    refreshTableSchemas,
    setFilePlan,
    loadedTables.length,
    loadedFileCount,
    updateLoadingStep,
  ])

  useEffect(() => {
    if (credentialsQuery.data && !isLoadingUrls) {
      void loadDataIntoDb()
    }
  }, [credentialsQuery.data, isLoadingUrls, loadDataIntoDb])

  useEffect(() => {
    const credentialsResult = credentialsQuery.data
    if (!credentialsResult || credentialsResult.error || !credentialsResult.result) {
      return
    }

    const { expiration: rawExpiration, ttlSeconds } = credentialsResult.result.credentials
    const now = Date.now()

    const expirationMs = (() => {
      if (typeof rawExpiration === "string") {
        const asDate = Date.parse(rawExpiration)
        if (Number.isFinite(asDate) && asDate > 0) {
          return asDate
        }
      }

      const numericExpiration = Number(rawExpiration)
      if (Number.isFinite(numericExpiration) && numericExpiration > 0) {
        // Supports epoch milliseconds, epoch seconds, and short TTL-style numeric values.
        if (numericExpiration > 1_000_000_000_000) return numericExpiration
        if (numericExpiration > 1_000_000_000) return numericExpiration * 1000
        return now + numericExpiration * 1000
      }

      const numericTtl = Number(ttlSeconds)
      if (Number.isFinite(numericTtl) && numericTtl > 0) {
        return now + numericTtl * 1000
      }

      return null
    })()

    if (!expirationMs) {
      return
    }

    const refreshDelayMs = expirationMs - now - CREDENTIAL_REFRESH_BUFFER_MS
    if (refreshDelayMs <= 0) {
      return
    }

    const refreshTimeout = window.setTimeout(() => {
      void credentialsQuery.refetch()
    }, refreshDelayMs)

    return () => window.clearTimeout(refreshTimeout)
  }, [credentialsQuery.data, credentialsQuery.refetch])

  // Reset state when interval changes to force reload
  useEffect(() => {
    loadedCatalogFingerprintRef.current = null
    setLoadedTables([])
    setLoadedFileCount(0)
    setExecutedQuery(null)
    setManualQueryError(null)
    setFilePlan(null)
    updateLoadingStep("")
  }, [interval, setFilePlan, updateLoadingStep])

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
    void credentialsQuery.refetch()
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
    if (hasUsage && hasMetadata) return PREDEFINED_LAKEHOUSE_QUERIES.allUsage.query
    if (hasUsage) return PREDEFINED_LAKEHOUSE_QUERIES.usageByFeature.query
    if (hasVerification) return PREDEFINED_LAKEHOUSE_QUERIES.verificationByFeature.query
    if (hasMetadata) return PREDEFINED_LAKEHOUSE_QUERIES.metadataRaw.query
    if (hasEntitlementSnapshots) return PREDEFINED_LAKEHOUSE_QUERIES.entitlementSnapshotsRaw.query
    return ""
  }, [hasUsage, hasMetadata, hasVerification, hasEntitlementSnapshots])

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

  const metadataCoverageQuery = `WITH metadata_dedup AS (
  SELECT
    CAST(id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(payload) AS payload
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
    FROM unnest(json_keys(payload)) AS t(tag)
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
    TRY_CAST("timestamp" AS DOUBLE) AS ts_num,
    TRY_CAST("timestamp" AS TIMESTAMP) AS ts_native,
    usage
  FROM usage
  WHERE deleted = 0
),
normalized AS (
  SELECT
    CASE
      WHEN ts_native IS NOT NULL THEN CAST(ts_native AS TIMESTAMP)
      WHEN ts_num IS NULL THEN NULL
      WHEN ts_num > 10000000000 THEN epoch_ms(CAST(ts_num AS BIGINT))
      ELSE epoch_ms(CAST(ts_num * 1000.0 AS BIGINT))
    END AS ts,
    usage
  FROM base
)
SELECT
  strftime(CAST(date_trunc('minute', ts) AS TIMESTAMP), '%Y-%m-%d %H:%M') AS minute,
  COUNT(*) AS events,
  SUM(usage) AS total_usage
FROM normalized
WHERE ts IS NOT NULL
GROUP BY minute
ORDER BY minute`

  const verificationTrendQuery = `WITH base AS (
  SELECT
    TRY_CAST("timestamp" AS DOUBLE) AS ts_num,
    TRY_CAST("timestamp" AS TIMESTAMP) AS ts_native,
    allowed
  FROM verifications
),
normalized AS (
  SELECT
    CASE
      WHEN ts_native IS NOT NULL THEN CAST(ts_native AS TIMESTAMP)
      WHEN ts_num IS NULL THEN NULL
      WHEN ts_num > 10000000000 THEN epoch_ms(CAST(ts_num AS BIGINT))
      ELSE epoch_ms(CAST(ts_num * 1000.0 AS BIGINT))
    END AS ts,
    allowed
  FROM base
)
SELECT
  strftime(CAST(date_trunc('minute', ts) AS TIMESTAMP), '%Y-%m-%d %H:%M') AS minute,
  SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) AS allowed,
  SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) AS denied
FROM normalized
WHERE ts IS NOT NULL
GROUP BY minute
ORDER BY minute`

  const usageSummary = useSql({ query: usageSummaryQuery, enabled: hasUsage })
  const verificationSummary = useSql({ query: verificationSummaryQuery, enabled: hasVerification })
  const metadataCoverage = useSql({
    query: metadataCoverageQuery,
    enabled: hasUsage && hasMetadata,
  })
  const usageTrend = useSql({ query: usageTrendQuery, enabled: hasUsage })
  const verificationTrend = useSql({ query: verificationTrendQuery, enabled: hasVerification })

  const numberFmt = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }),
    []
  )

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
  const metadataCoverageRow = useMemo(
    () => tableToRows(metadataCoverage.data?.arrowTable)[0],
    [metadataCoverage.data?.arrowTable, tableToRows]
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

  const usageEvents = Number(usageSummaryRow?.events ?? 0)
  const usageTotal = Number(usageSummaryRow?.total_usage ?? 0)
  const verificationAllowed = Number(verificationSummaryRow?.allowed ?? 0)
  const verificationDenied = Number(verificationSummaryRow?.denied ?? 0)
  const metadataTagged = Number(metadataCoverageRow?.with_meta ?? 0)
  const metadataTotal = Number(metadataCoverageRow?.total ?? 0)

  const snapshotStatus = useMemo(() => {
    if (error) {
      return {
        label: "Needs attention",
        tone: "text-destructive",
        dotTone: "bg-destructive",
        pulseTone: "bg-destructive/60",
        pulse: false,
      }
    }

    if (isLoading) {
      return {
        label: "Syncing snapshot",
        tone: "text-amber-700 dark:text-amber-400",
        dotTone: "bg-amber-500",
        pulseTone: "bg-amber-500/60",
        pulse: true,
      }
    }

    if (!tableReady) {
      return {
        label: "Waiting for data",
        tone: "text-muted-foreground",
        dotTone: "bg-muted-foreground/50",
        pulseTone: "bg-muted-foreground/60",
        pulse: false,
      }
    }

    return {
      label: "Snapshot synced",
      tone: "text-emerald-700 dark:text-emerald-400",
      dotTone: "bg-emerald-500",
      pulseTone: "bg-emerald-500/60",
      pulse: true,
    }
  }, [error, isLoading, tableReady])

  const lastSyncedLabel = useMemo(() => {
    if (!credentialsQuery.dataUpdatedAt) return "—"
    return new Date(credentialsQuery.dataUpdatedAt).toLocaleString()
  }, [credentialsQuery.dataUpdatedAt])

  const predefinedQueryOptions = useMemo(() => {
    return Object.entries(PREDEFINED_LAKEHOUSE_QUERIES).map(([key, value]) => {
      const queryKey = key as PredefinedLakehouseQueryKey
      const required = requiredTables(value.query)
      const disabled = required.some((table) => !loadedTables.includes(table))

      return {
        key: queryKey,
        label: value.label,
        disabled,
      }
    })
  }, [loadedTables, requiredTables])

  const quickQueries = useMemo(() => {
    return QUICK_QUERY_KEYS.map((queryKey) =>
      predefinedQueryOptions.find((option) => option.key === queryKey)
    ).filter((option): option is (typeof predefinedQueryOptions)[number] => Boolean(option))
  }, [predefinedQueryOptions])

  const handleApplyQuery = useCallback(
    (queryKey: PredefinedLakehouseQueryKey) => {
      const query = PREDEFINED_LAKEHOUSE_QUERIES[queryKey]
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

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 pt-6">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <p className="text-destructive text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <Card className="w-full">
          <CardContent className="flex items-center gap-3 py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <p className="font-medium">Syncing lakehouse snapshot...</p>
              <p className="text-muted-foreground text-sm">
                {isLoadingUrls
                  ? "Fetching file plan from the lakehouse service."
                  : loadingStep || "Importing parquet files."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

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
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                Retry load
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {tableReady && (
        <>
          <motion.section {...SECTION_MOTION}>
            <div className="grid gap-4 lg:grid-cols-3">
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

          <motion.section {...SECTION_MOTION}>
            <div className="grid gap-4 lg:grid-cols-2">
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
                      config={usageTrendChartConfig}
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
                          tickFormatter={(value) => formatMinuteTick(value, usageMinuteSameDay)}
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

              <Card className="border-muted/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Verification Outcomes</CardTitle>
                  <CardDescription>Allowed versus denied checks by snapshot minute</CardDescription>
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
                          tickFormatter={(value) =>
                            formatMinuteTick(value, verificationMinuteSameDay)
                          }
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
                  <Select
                    value=""
                    onValueChange={(key: string) => {
                      const query = PREDEFINED_LAKEHOUSE_QUERIES[key as PredefinedLakehouseQueryKey]
                      if (query) {
                        setSqlQuery(query.query)
                        setManualQueryError(null)
                      }
                    }}
                  >
                    <SelectTrigger className="w-[220px]">
                      <SelectValue placeholder="Load predefined query..." />
                    </SelectTrigger>
                    <SelectContent>
                      {predefinedQueryOptions.map((option) => (
                        <SelectItem key={option.key} value={option.key} disabled={option.disabled}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mr-1 text-muted-foreground text-xs">Quick runs:</p>
                  {quickQueries.map((option) => (
                    <Button
                      key={option.key}
                      variant="outline"
                      size="sm"
                      onClick={() => handleApplyQuery(option.key)}
                      disabled={option.disabled || showQueryLoading}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>

                <div className="overflow-hidden rounded-md border">
                  <SqlMonacoEditor
                    value={sqlQuery}
                    onChange={handleSqlChange}
                    height="200px"
                    tableSchemas={tables}
                    getLatestSchemas={getLatestSchemas}
                  />
                </div>

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

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadTable}
                    disabled={!queryResult?.arrowTable}
                  >
                    <ArrowDownToLine className="mr-2 h-4 w-4" />
                    Download CSV
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
          </motion.section>
        </>
      )}

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
        </motion.div>
      )}
    </div>
  )
}

// ============================================================================
// Main Dashboard Component (wraps with RoomShell)
// ============================================================================

export function LakehouseDashboardSqlrooms() {
  const mounted = useMounted()

  // Prevent SSR/hydration issues with DuckDB WASM and Monaco
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
