import { useQuery } from "@tanstack/react-query"
import * as Comlink from "comlink"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTRPC } from "~/trpc/client"
import type {
  DataSourceId,
  DuckDBWorkerAPI,
  PredefinedQueryName,
  QueryResult,
} from "../workers/duckdb-types"
import { DATA_SOURCES, getPredefinedQuery } from "../workers/duckdb-types"
import { useIntervalFilter } from "./use-filter"

export type RangeType = "24h" | "7d" | "30d" | "90d"

interface ManifestFile {
  url: string
  key: string
  day: string
  type: "raw" | "compact"
  count: number
  bytes: number
}

interface UseUsageDuckdbResult {
  // State
  isInitializing: boolean
  isLoading: boolean
  isReady: boolean
  error: string | null

  // Data info
  loadedFileCount: number
  totalEvents: number

  // Actions
  loadRange: (range: RangeType) => Promise<void>
  runAggregation: (name: PredefinedQueryName) => Promise<QueryResult | null>
  runCustomQuery: (sql: string) => Promise<QueryResult | null>
  getMetadataKeys: () => Promise<string[]>
  runMetadataAggregation: (metadataKey: string) => Promise<QueryResult | null>
  clearData: () => Promise<void>
}

export interface UseUsageDuckdbOptions {
  /** Which event table to load and query. Default: 'usage_events'. Use 'verification_events' for verification data. */
  dataSource?: DataSourceId
}

/**
 * Hook for using DuckDB with event data (usage or verification).
 *
 * Features:
 * - Lazy initialization of DuckDB worker
 * - dataSource: choose which table to load/query (usage_events | verification_events)
 * - Fetches manifest via tRPC and loads files for selected range into the chosen table
 * - Caches loaded files (won't re-download on page reload due to Service Worker)
 * - Provides predefined aggregation queries scoped to the selected table
 */
export function useUsageDuckdb(
  projectId: string,
  options: UseUsageDuckdbOptions = {}
): UseUsageDuckdbResult {
  const { dataSource = "usage_events" } = options
  const workerRef = useRef<Comlink.Remote<DuckDBWorkerAPI> | null>(null)
  const rawWorkerRef = useRef<Worker | null>(null)

  const [isInitializing, setIsInitializing] = useState(true)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedFileCount, setLoadedFileCount] = useState(0)
  const [totalEvents, setTotalEvents] = useState(0)

  const trpc = useTRPC()
  const [interval, setIntervalFilter] = useIntervalFilter()

  // Fetch URLs using tRPC
  const {
    data: urls,
    isLoading: isLoadingUrls,
    error: urlsError,
  } = useQuery(
    trpc.analytics.getLakehouseUrls.queryOptions(
      {
        interval: interval.name,
      },
      {
        staleTime: 1000 * 60 * 5,
      }
    )
  )

  const isLoading = isLoadingUrls || isProcessing
  const finalError = error || (urlsError ? urlsError.message : null)

  // Initialize worker on mount
  useEffect(() => {
    async function initWorker() {
      try {
        console.info("[useUsageDuckdb] Creating worker...")
        // In Next.js, we load the worker from the public folder (built via esbuild)
        const worker = new Worker("/duckdb.worker.js")
        rawWorkerRef.current = worker

        const wrapped = Comlink.wrap<DuckDBWorkerAPI>(worker)
        workerRef.current = wrapped

        console.info("[useUsageDuckdb] Initializing DuckDB...")
        await wrapped.init()

        setIsInitializing(false)
        console.info("[useUsageDuckdb] Ready")
      } catch (err) {
        console.error("[useUsageDuckdb] Init error:", err)
        setError(err instanceof Error ? err.message : "Failed to initialize DuckDB")
        setIsInitializing(false)
      }
    }

    initWorker()

    // Cleanup on unmount
    return () => {
      if (rawWorkerRef.current) {
        rawWorkerRef.current.terminate()
      }
    }
  }, [])

  /**
   * Load data when URLs change
   */
  useEffect(() => {
    if (!workerRef.current || isInitializing || !urls) return

    const loadData = async () => {
      setIsProcessing(true)
      setError(null)

      try {
        const typedUrls = urls as unknown as { result: { manifest: { files: ManifestFile[] } } }
        const manifestResult = typedUrls.result?.manifest

        if (!manifestResult) return

        // Check if we have files
        if (!manifestResult.files || manifestResult.files.length === 0) {
          await workerRef.current!.clearData(dataSource)
          setLoadedFileCount(0)
          setTotalEvents(0)
          setIsReady(true)
          return
        }

        // Clear previous data for this table before loading new range
        await workerRef.current!.clearData(dataSource)

        // Load files into DuckDB (pass tenantId and target table)
        const filesToLoad = manifestResult.files.map((f: ManifestFile) => ({
          url: f.url,
          key: f.key,
        }))
        const result = await workerRef.current!.loadFiles(filesToLoad, projectId, dataSource)

        console.info(`[useUsageDuckdb] Loaded ${result.loaded} files, ${result.totalEvents} events`)

        setLoadedFileCount(result.loaded)
        setTotalEvents(result.totalEvents)
        setIsReady(true)
      } catch (err) {
        console.error("[useUsageDuckdb] Load error:", err)
        setError(err instanceof Error ? err.message : "Failed to load data")
      } finally {
        setIsProcessing(false)
      }
    }

    void loadData()
  }, [urls, isInitializing, dataSource, projectId])

  /**
   * Update the range filter
   */
  const loadRange = useCallback(
    async (range: RangeType) => {
      await setIntervalFilter({ intervalFilter: range })
    },
    [setIntervalFilter]
  )

  /**
   * Run a predefined aggregation query
   */
  const runAggregation = useCallback(
    async (name: PredefinedQueryName): Promise<QueryResult | null> => {
      if (!workerRef.current || !isReady) {
        setError("Data not loaded")
        return null
      }

      const sql = getPredefinedQuery(name, dataSource)
      if (!sql) {
        setError(`Unknown query: ${name}`)
        return null
      }

      try {
        return await workerRef.current.runQuery(sql)
      } catch (err) {
        console.error("[useUsageDuckdb] Query error:", err)
        setError(err instanceof Error ? err.message : "Query failed")
        return null
      }
    },
    [isReady, dataSource]
  )

  /**
   * Run a custom SQL query
   */
  const runCustomQuery = useCallback(
    async (sql: string): Promise<QueryResult | null> => {
      if (!workerRef.current || !isReady) {
        setError("Data not loaded")
        return null
      }

      try {
        return await workerRef.current.runQuery(sql)
      } catch (err) {
        console.error("[useUsageDuckdb] Query error:", err)
        setError(err instanceof Error ? err.message : "Query failed")
        return null
      }
    },
    [isReady]
  )

  /**
   * Get distinct top-level keys from events.metadata JSON (for selector)
   */
  const getMetadataKeys = useCallback(async (): Promise<string[]> => {
    if (!workerRef.current || !isReady) return []

    try {
      const tableName = DATA_SOURCES[dataSource].tableName
      const res = await workerRef.current.runQuery(
        `SELECT DISTINCT unnest(json_keys(metadata))::VARCHAR as key FROM ${tableName} WHERE metadata IS NOT NULL ORDER BY key`
      )
      if (!res?.rows?.length) return []
      const keyCol = res.columns.find((c) => c.toLowerCase() === "key") ?? res.columns[0]
      return res.rows.map((r) => String(r[keyCol as keyof typeof r] ?? "")).filter(Boolean)
    } catch {
      return []
    }
  }, [isReady, dataSource])

  /**
   * Run aggregation grouped by a metadata key (value → count). Key is sanitized (alphanumeric + underscore only).
   */
  const runMetadataAggregation = useCallback(
    async (metadataKey: string): Promise<QueryResult | null> => {
      if (!workerRef.current || !isReady) {
        setError("Data not loaded")
        return null
      }

      const sanitized = metadataKey.replace(/[^a-zA-Z0-9_]/g, "")
      if (!sanitized) {
        setError("Invalid metadata key")
        return null
      }

      const path = `$.${sanitized}`
      const tableName = DATA_SOURCES[dataSource].tableName
      const sql = `SELECT json_extract_string(metadata, '${path}') as value, COUNT(*) as count FROM ${tableName} WHERE metadata IS NOT NULL GROUP BY value ORDER BY count DESC LIMIT 50`

      try {
        return await workerRef.current.runQuery(sql)
      } catch (err) {
        console.error("[useUsageDuckdb] Metadata query error:", err)
        setError(err instanceof Error ? err.message : "Metadata query failed")
        return null
      }
    },
    [isReady, dataSource]
  )

  /**
   * Clear all loaded data
   */
  const clearData = useCallback(async () => {
    if (!workerRef.current) return

    await workerRef.current.clearData(dataSource)
    setLoadedFileCount(0)
    setTotalEvents(0)
    setIsReady(false)
  }, [dataSource])

  return {
    isInitializing,
    isLoading,
    isReady,
    error: finalError,
    loadedFileCount,
    totalEvents,
    loadRange,
    runAggregation,
    runCustomQuery,
    getMetadataKeys,
    runMetadataAggregation,
    clearData,
  }
}
