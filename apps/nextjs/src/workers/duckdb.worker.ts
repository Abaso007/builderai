import * as duckdb from "@duckdb/duckdb-wasm"
import * as Comlink from "comlink"
import type {
  DataSourceDef,
  DataSourceId,
  DuckDBWorkerAPI,
  FileToLoad,
  QueryResult,
} from "./duckdb-types"
import {
  DATA_SOURCES,
  DATA_SOURCE_IDS,
  buildCreateTableSQL,
  formatRowForInsert,
  parseNdjsonRow,
} from "./duckdb-types"

// In Next.js, these are served from public/duckdb/
const getDuckDbBase = () =>
  typeof window !== "undefined" ? `${window.location.origin}/duckdb` : "/duckdb"

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: `${getDuckDbBase()}/duckdb-mvp.wasm`,
    mainWorker: `${getDuckDbBase()}/duckdb-browser-mvp.worker.js`,
  },
  eh: {
    mainModule: `${getDuckDbBase()}/duckdb-eh.wasm`,
    mainWorker: `${getDuckDbBase()}/duckdb-browser-eh.worker.js`,
  },
}

/**
 * DuckDB Web Worker
 *
 * Generic data worker: creates tables and inserts rows from schema definitions in duckdb-types.
 * No hardcoded column names or schemas; all structure comes from DATA_SOURCES.
 */

let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null

/** Loaded file URLs per table, so we don't re-load the same file into the same table. */
const loadedFilesByTable = new Map<DataSourceId, Set<string>>()

function getLoadedSet(table: DataSourceId): Set<string> {
  let set = loadedFilesByTable.get(table)
  if (!set) {
    set = new Set<string>()
    loadedFilesByTable.set(table, set)
  }
  return set
}

const INSERT_BATCH_SIZE = 2000

/** Stream NDJSON from response body, yield parsed rows keyed by column name (schema from def). */
async function* streamNdjson(
  response: Response,
  def: DataSourceDef
): AsyncGenerator<Record<string, unknown>> {
  const body = response.body
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const row = parseNdjsonRow(trimmed, def)
        if (row) yield row
      }
    }
    if (buffer.trim()) {
      const row = parseNdjsonRow(buffer.trim(), def)
      if (row) yield row
    }
  } finally {
    reader.releaseLock()
  }
}

/** Build and run a single batch INSERT using schema from def. */
async function insertBatch(
  conn: duckdb.AsyncDuckDBConnection,
  def: DataSourceDef,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return

  const columnList = def.columns.map((c) => c.name).join(", ")
  const values = rows.map((r) => formatRowForInsert(r, def)).join(", ")
  const sql = `INSERT INTO ${def.tableName} (${columnList}) VALUES ${values}`
  await conn.query(sql)
}

const workerAPI: DuckDBWorkerAPI = {
  /**
   * Initialize DuckDB
   */
  async init(): Promise<void> {
    if (db) {
      console.info("[DuckDB Worker] Already initialized")
      return
    }

    console.info("[DuckDB Worker] Initializing...")

    // Select appropriate bundle
    const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES)
    const workerUrl = bundle.mainWorker
    if (!workerUrl) {
      throw new Error("DuckDB bundle has no mainWorker")
    }

    // Create worker
    const worker = new Worker(workerUrl)
    const logger = new duckdb.ConsoleLogger()

    // Instantiate DuckDB
    db = new duckdb.AsyncDuckDB(logger, worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)

    // Open connection
    conn = await db.connect()

    // Create one table per data source from schema registry
    for (const id of DATA_SOURCE_IDS) {
      const def = DATA_SOURCES[id]
      await conn.query(buildCreateTableSQL(def))
    }

    console.info("[DuckDB Worker] Initialized successfully")
  },

  /**
   * Load NDJSON files into DuckDB via streaming + batched inserts
   * @param projectId - Sent as X-Project-Id header so /api/dashboard/file returns 200
   * @param targetTable - Which event table to insert into (default: usage_events)
   */
  async loadFiles(
    files: FileToLoad[],
    projectId: string,
    targetTable: DataSourceId = "usage_events"
  ): Promise<{ loaded: number; totalEvents: number }> {
    if (!db || !conn) {
      throw new Error("DuckDB not initialized. Call init() first.")
    }

    const def = DATA_SOURCES[targetTable]
    let loaded = 0
    let totalEvents = 0
    const headers: Record<string, string> = { "X-Project-Id": projectId }
    const loadedFiles = getLoadedSet(targetTable)

    for (const file of files) {
      if (loadedFiles.has(file.url)) {
        console.info("[DuckDB Worker] Skipping already loaded:", file.url, targetTable)
        continue
      }

      try {
        console.info("[DuckDB Worker] Streaming:", file.url, "→", def.tableName)

        const response = await fetch(file.url, { headers })
        if (!response.ok) {
          console.warn("[DuckDB Worker] Failed to fetch:", file.url, response.status)
          continue
        }

        let fileEventCount = 0
        let batch: Record<string, unknown>[] = []

        for await (const row of streamNdjson(response, def)) {
          batch.push(row)
          if (batch.length >= INSERT_BATCH_SIZE) {
            await insertBatch(conn, def, batch)
            fileEventCount += batch.length
            batch = []
          }
        }

        if (batch.length > 0) {
          await insertBatch(conn, def, batch)
          fileEventCount += batch.length
        }

        if (fileEventCount === 0) {
          loadedFiles.add(file.url)
          continue
        }

        totalEvents += fileEventCount
        loadedFiles.add(file.url)
        loaded++
        console.info(
          `[DuckDB Worker] Loaded ${fileEventCount} events from ${file.url} into ${def.tableName}`
        )
      } catch (error) {
        console.error("[DuckDB Worker] Error loading file:", file.url, error)
      }
    }

    return { loaded, totalEvents }
  },

  /**
   * Run a SQL query
   */
  async runQuery(sql: string): Promise<QueryResult> {
    if (!conn) {
      throw new Error("DuckDB not initialized. Call init() first.")
    }

    const startTime = performance.now()

    try {
      const result = await conn.query(sql)
      const endTime = performance.now()

      // Convert Arrow table to JSON-friendly format
      const columns = result.schema.fields.map((f) => f.name)
      const rows: Record<string, unknown>[] = []

      for (let i = 0; i < result.numRows; i++) {
        const row: Record<string, unknown> = {}
        for (const col of columns) {
          const value = result.getChild(col)?.get(i)
          // Convert BigInt to number for JSON serialization
          row[col] = typeof value === "bigint" ? Number(value) : value
        }
        rows.push(row)
      }

      return {
        columns,
        rows,
        rowCount: result.numRows,
        executionTimeMs: endTime - startTime,
      }
    } catch (error) {
      console.error("[DuckDB Worker] Query error:", error)
      throw error
    }
  },

  /**
   * Get count of loaded files (for one table or all tables)
   */
  async getLoadedFileCount(table?: DataSourceId): Promise<number> {
    if (table) {
      return getLoadedSet(table).size
    }
    let total = 0
    for (const id of DATA_SOURCE_IDS) {
      total += getLoadedSet(id).size
    }
    return total
  },

  /**
   * Clear loaded data for one table or all tables
   */
  async clearData(table?: DataSourceId): Promise<void> {
    if (!conn) return

    const tablesToClear = table ? [table] : DATA_SOURCE_IDS
    for (const id of tablesToClear) {
      const def = DATA_SOURCES[id]
      await conn.query(`DROP TABLE IF EXISTS ${def.tableName}`)
      await conn.query(buildCreateTableSQL(def))
      getLoadedSet(id).clear()
    }

    console.info("[DuckDB Worker] Data cleared", table ?? "(all tables)")
  },
}

// Expose API via Comlink
Comlink.expose(workerAPI)
