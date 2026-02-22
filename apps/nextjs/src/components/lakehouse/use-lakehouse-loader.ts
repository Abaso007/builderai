import type { DataTable } from "@sqlrooms/duckdb"
import { useCallback, useRef, useState } from "react"
import { TABLE_CONFIG, type TableSource } from "./lakehouse-constants"
import {
  computeCatalogFingerprint,
  escapeSqlString,
  selectInitialQuery,
  withTimeout,
} from "./lakehouse-utils"
import type { LakehouseFilePlan } from "./sqlrooms-store"

type Connector = { query: (sql: string) => PromiseLike<unknown> }

interface Options {
  credentialsData: { result: LakehouseFilePlan | null; error?: string | null } | null | undefined
  onRefetch: () => void
  getConnector: () => PromiseLike<Connector>
  refreshTableSchemas: () => PromiseLike<DataTable[]>
  addOrUpdateSqlQueryDataSource: (tableName: string, query: string) => PromiseLike<void>
  removeDataSource: (tableName: string) => PromiseLike<void>
  setFilePlan: (plan: LakehouseFilePlan | null) => void
  onTablesLoaded: (tables: string[], initialQuery: string) => void
}

export interface LakehouseLoaderState {
  isLoadingData: boolean
  loadingStep: string
  loadError: string | null
  loadedFileCount: number
  loadedTables: string[]
  loadDataIntoDb: () => Promise<void>
  resetLoader: () => void
}

const isCredentialError = (err: unknown) =>
  /expired|invalid.+token|accessdenied|forbidden|http\s*403|unauthorized/i.test(
    err instanceof Error ? err.message : String(err)
  )

function getScopedProjectIds(filePlan: LakehouseFilePlan): string[] {
  const projectIds = [
    ...new Set((filePlan.projectIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ]
  if (projectIds.length === 0) {
    throw new Error("Lakehouse file plan did not include any project IDs")
  }
  return projectIds.sort((a, b) => a.localeCompare(b))
}

export function useLakehouseLoader({
  credentialsData,
  onRefetch,
  getConnector,
  refreshTableSchemas,
  addOrUpdateSqlQueryDataSource,
  removeDataSource,
  setFilePlan,
  onTablesLoaded,
}: Options): LakehouseLoaderState {
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [loadingStep, setLoadingStep] = useState("")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedFileCount, setLoadedFileCount] = useState(0)
  const [loadedTables, setLoadedTables] = useState<string[]>([])

  const catalogFingerprintRef = useRef<string | null>(null)
  const credentialRefreshRetryRef = useRef(false)
  const loadingStepRef = useRef("")
  const isLoadingRef = useRef(false)

  const updateStep = useCallback((step: string) => {
    loadingStepRef.current = step
    setLoadingStep(step)
  }, [])

  const loadDataIntoDb = useCallback(async () => {
    if (!credentialsData?.result || credentialsData.error) return
    if (isLoadingRef.current) return

    isLoadingRef.current = true
    setIsLoadingData(true)
    setLoadError(null)
    updateStep("Connecting to local analytics engine")

    try {
      const filePlan = credentialsData.result
      const catalogFingerprint = computeCatalogFingerprint(filePlan)
      setFilePlan(filePlan)

      // ── Empty file plan: clear state and bail out ────────────────────────
      if (filePlan.urls.length === 0) {
        catalogFingerprintRef.current = catalogFingerprint
        credentialRefreshRetryRef.current = false
        setLoadedFileCount(0)
        setLoadedTables([])
        onTablesLoaded([], "")
        return
      }

      // ── Missing credentials for non-empty plan ───────────────────────────
      if (!filePlan.credentials) {
        throw new Error("Missing temporary credentials for non-empty file plan")
      }
      const scopedProjectIds = getScopedProjectIds(filePlan)
      const scopedProjectWhere = `project_id IN (${scopedProjectIds
        .map((id) => `'${escapeSqlString(id)}'`)
        .join(", ")})`

      // ── Fast exit: fingerprint unchanged ────────────────────────────────
      if (catalogFingerprintRef.current === catalogFingerprint) return

      const connector = await withTimeout(getConnector(), 20_000, "initializing local DuckDB")

      // ── Full load ────────────────────────────────────────────────────────
      const endpointHost = (() => {
        try {
          return new URL(filePlan.credentials.r2Endpoint).host
        } catch {
          return filePlan.credentials.r2Endpoint.replace(/^https?:\/\//, "")
        }
      })()

      updateStep("Loading HTTP file extension")
      try {
        await withTimeout(connector.query("INSTALL httpfs"), 20_000, "installing httpfs")
      } catch (e) {
        console.warn("[useLakehouseLoader] INSTALL httpfs skipped:", e)
      }
      await withTimeout(connector.query("LOAD httpfs"), 20_000, "loading httpfs")
      await withTimeout(connector.query("SET enable_object_cache = true;"), 20_000, "setting cache")

      updateStep("Applying temporary lakehouse credentials")
      const { accessKeyId, secretAccessKey, sessionToken } = filePlan.credentials
      await withTimeout(
        connector.query(`CREATE OR REPLACE SECRET lakehouse_r2_secret (
          TYPE S3,
          KEY_ID '${escapeSqlString(accessKeyId)}',
          SECRET '${escapeSqlString(secretAccessKey)}',
          SESSION_TOKEN '${escapeSqlString(sessionToken)}',
          ENDPOINT '${escapeSqlString(endpointHost)}',
          URL_STYLE 'path',
          REGION 'auto'
        )`),
        20_000,
        "creating temporary R2 secret"
      )

      const readParquet = (urls: string[]) => {
        const paths = urls.map((u) => `'${escapeSqlString(u)}'`).join(", ")
        return `read_parquet([${paths}], union_by_name = true)`
      }

      const sourceQuery = (source: TableSource, files: string[]) => {
        const sourceSql = readParquet(files)
        const baseSelect =
          source === "verification"
            ? `SELECT * REPLACE (CAST(denied_reason AS VARCHAR) AS denied_reason) FROM ${sourceSql}`
            : `SELECT * FROM ${sourceSql}`
        return `${baseSelect} WHERE ${scopedProjectWhere}`
      }

      const loadSource = async (source: TableSource): Promise<number> => {
        const { tableName, label } = TABLE_CONFIG[source]
        const files = filePlan.tableFiles[source] ?? []

        if (files.length === 0) {
          updateStep(`Clearing ${label}`)
          await withTimeout(removeDataSource(tableName), 20_000, `clearing ${label}`)
          await withTimeout(
            connector.query(`DROP TABLE IF EXISTS ${tableName}`),
            20_000,
            `dropping stale ${label} table`
          )
          return 0
        }

        updateStep(`Importing ${label} (${files.length} ${files.length === 1 ? "file" : "files"})`)

        await withTimeout(
          addOrUpdateSqlQueryDataSource(tableName, sourceQuery(source, files)),
          240_000,
          `importing ${label}`
        )
        return files.length
      }

      const tablesLoaded: string[] = []
      let totalFiles = 0

      for (const source of Object.keys(TABLE_CONFIG) as TableSource[]) {
        const count = await loadSource(source)
        if (count > 0) {
          tablesLoaded.push(TABLE_CONFIG[source].tableName)
          totalFiles += count
        }
      }

      updateStep("Refreshing table schemas")
      await withTimeout(refreshTableSchemas(), 20_000, "refreshing table schemas")

      catalogFingerprintRef.current = catalogFingerprint
      credentialRefreshRetryRef.current = false
      setLoadedTables(tablesLoaded)
      setLoadedFileCount(totalFiles)
      onTablesLoaded(tablesLoaded, selectInitialQuery(tablesLoaded))
      updateStep("Snapshot synced")
    } catch (err) {
      console.error("[useLakehouseLoader]", err)
      if (isCredentialError(err) && !credentialRefreshRetryRef.current) {
        credentialRefreshRetryRef.current = true
        catalogFingerprintRef.current = null
        onRefetch()
        return
      }
      credentialRefreshRetryRef.current = false
      const prefix = loadingStepRef.current ? `${loadingStepRef.current}: ` : ""
      const message = err instanceof Error ? err.message : "Failed to load data"
      setLoadError(`${prefix}${message}`)
    } finally {
      isLoadingRef.current = false
      setIsLoadingData(false)
      setLoadingStep("")
    }
    // loadedTables/loadedFileCount intentionally excluded — catalogFingerprintRef guards duplicates
  }, [
    credentialsData,
    onRefetch,
    getConnector,
    refreshTableSchemas,
    addOrUpdateSqlQueryDataSource,
    removeDataSource,
    setFilePlan,
    onTablesLoaded,
    updateStep,
  ])

  const resetLoader = useCallback(() => {
    catalogFingerprintRef.current = null
    setLoadedTables([])
    setLoadedFileCount(0)
    setLoadError(null)
    setLoadingStep("")
  }, [])

  return {
    isLoadingData,
    loadingStep,
    loadError,
    loadedFileCount,
    loadedTables,
    loadDataIntoDb,
    resetLoader,
  }
}
