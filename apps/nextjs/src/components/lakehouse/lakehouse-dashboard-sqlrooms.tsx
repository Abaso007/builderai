"use client"

import { DataTableArrowPaginated } from "@sqlrooms/data-table"
import { useSql } from "@sqlrooms/duckdb"
import { RoomShell } from "@sqlrooms/room-shell"
import { SqlMonacoEditor } from "@sqlrooms/sql-editor"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Skeleton } from "@unprice/ui/skeleton"
import { AlertCircle, Database, Loader2, Play, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
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
}

// ============================================================================
// Predefined Queries
// ============================================================================

const PREDEFINED_QUERIES = {
  all: {
    label: "All Usage",
    description: "View all usage events with metadata",
    query: `SELECT
  u.*,
  m.tags as metadata_tags
FROM usage u
LEFT JOIN metadata m ON u.meta_id = CAST(m.meta_id AS VARCHAR)
WHERE u.deleted = 0
LIMIT 100`,
  },
  byFeature: {
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
  byCustomer: {
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
  byApiKey: {
    label: "Usage by API Key",
    description: "Aggregate usage grouped by API key",
    query: `SELECT
  u.key_id,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.customer_id) as unique_customers,
  COUNT(DISTINCT u.feature_slug) as features_used,
  MIN(u.timestamp) as first_event,
  MAX(u.timestamp) as last_event
FROM usage u
WHERE u.deleted = 0
GROUP BY u.key_id
ORDER BY total_usage DESC`,
  },
  byRegion: {
    label: "Usage by Region",
    description: "Aggregate usage grouped by region/geography",
    query: `SELECT
  u.region,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.customer_id) as unique_customers,
  COUNT(DISTINCT u.feature_slug) as features_used,
  MIN(u.timestamp) as first_event,
  MAX(u.timestamp) as last_event
FROM usage u
WHERE u.deleted = 0
GROUP BY u.region
ORDER BY total_usage DESC`,
  },
} as const

type QueryKey = keyof typeof PREDEFINED_QUERIES

const DEFAULT_QUERY = PREDEFINED_QUERIES.all.query

// Table configurations for each data source
const TABLE_CONFIG = {
  usage: { tableName: "usage", label: "Usage Events" },
  verification: { tableName: "verifications", label: "Verifications" },
  metadata: { tableName: "metadata", label: "Metadata" },
} as const

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
  const [loadedFileCount, setLoadedFileCount] = useState(0)
  const [loadedTables, setLoadedTables] = useState<string[]>([])

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
        setLoadedFileCount(0)
        setLoadedTables([])
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
      setLoadedFileCount(totalFiles)
      setLoadedTables(tablesLoaded)

      // Auto-execute default query after loading if we have usage
      if (tablesLoaded.includes("usage")) {
        setExecutedQuery(DEFAULT_QUERY)
      }
    } catch (err) {
      console.error("[LakehouseDashboardSqlrooms] Load error:", err)
      setLoadError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setIsLoadingData(false)
    }
  }, [urlsData, getConnector, refreshTableSchemas])

  // Load data when URLs change
  useEffect(() => {
    if (urlsData && !isLoadingUrls) {
      void loadDataIntoDb()
    }
  }, [urlsData, isLoadingUrls, loadDataIntoDb])

  // Reset state when interval changes to force reload
  useEffect(() => {
    setLoadedTables([])
    setLoadedFileCount(0)
    setExecutedQuery(null)
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
      // If query is the same, we need to force re-execution by clearing and re-setting
      if (executedQuery === sqlQuery.trim()) {
        setExecutedQuery(null)
        // Use setTimeout to ensure state update happens before re-setting
        setTimeout(() => {
          setIsExecuting(true)
          setExecutedQuery(sqlQuery.trim())
        }, 0)
      } else {
        setIsExecuting(true)
        setExecutedQuery(sqlQuery.trim())
      }
    }
  }, [sqlQuery, executedQuery])

  // Handle refresh
  const handleRefresh = () => {
    void refetchUrls()
  }

  // Handle SQL editor change
  const handleSqlChange = useCallback((value: string | undefined) => {
    setSqlQuery(value ?? "")
  }, [])

  // Get latest table schemas for autocomplete
  const getLatestSchemas = useCallback(() => {
    return { tableSchemas: tables }
  }, [tables])

  const isLoading = isLoadingUrls || isLoadingData
  const error = urlsError?.message || loadError
  const showQueryLoading = isExecuting || isQueryLoading

  return (
    <div className="w-full min-w-0 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-2xl tracking-tight">Lakehouse SQL Explorer</h2>
          <p className="text-muted-foreground text-sm">
            {tableReady
              ? `${loadedFileCount} files loaded into ${loadedTables.length} tables (${loadedTables.join(", ")})`
              : isLoading
                ? "Loading data..."
                : "Waiting for data"}
          </p>
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
                Fetching and importing data files into DuckDB
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Table Info - Always visible with stable layout */}
      <Card className="w-full">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Available Tables</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex gap-2">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-7 w-20" />
            </div>
          ) : tableReady ? (
            <div className="flex flex-wrap gap-2">
              {tables.map((table) => (
                <div
                  key={table.table.table}
                  className="rounded-md bg-muted px-3 py-1 font-mono text-sm"
                >
                  {table.table.table}
                  <span className="ml-1 text-muted-foreground">({table.columns.length} cols)</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No tables loaded yet</p>
          )}
        </CardContent>
      </Card>

      {/* SQL Editor */}
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
                }
              }}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Predefined queries..." />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PREDEFINED_QUERIES).map(([key, { label }]) => (
                  <SelectItem key={key} value={key}>
                    <div className="flex flex-col">
                      <span>{label}</span>
                    </div>
                  </SelectItem>
                ))}
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
              disabled={!tableReady || showQueryLoading || !sqlQuery.trim()}
            >
              {showQueryLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {showQueryLoading ? "Running..." : "Execute"}
            </Button>

            {queryError && (
              <p className="text-destructive text-sm">Query error: {queryError.message}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Query Results */}
      {executedQuery && (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Query Results</CardTitle>
            <CardDescription>
              {queryResult
                ? `${queryResult.arrowTable?.numRows ?? 0} rows returned`
                : showQueryLoading
                  ? "Running query..."
                  : "No results"}
            </CardDescription>
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
              <p className="font-medium">Initializing DuckDB...</p>
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
