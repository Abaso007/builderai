import { CACHE_STATE_TABLE } from "./lakehouse-constants"
import { escapeSqlString, rowArrayFromResult, withTimeout } from "./lakehouse-utils"

type Connector = { query: (sql: string) => PromiseLike<unknown> }

export interface SnapshotCacheState {
  catalogFingerprint: string
  tables: string[]
  loadedFileCount: number
}

async function ensureCacheStateTable(connector: Connector) {
  await withTimeout(
    connector.query(`CREATE TABLE IF NOT EXISTS ${CACHE_STATE_TABLE} (
      state_key           VARCHAR PRIMARY KEY,
      catalog_fingerprint VARCHAR,
      tables_json         VARCHAR,
      loaded_file_count   BIGINT,
      updated_at          TIMESTAMP
    )`),
    20_000,
    "preparing snapshot cache state"
  )
}

export async function readSnapshotCacheState(
  connector: Connector
): Promise<SnapshotCacheState | null> {
  await ensureCacheStateTable(connector)
  const result = await withTimeout(
    connector.query(
      `SELECT catalog_fingerprint, tables_json, loaded_file_count
       FROM ${CACHE_STATE_TABLE} WHERE state_key = 'latest' LIMIT 1`
    ),
    20_000,
    "reading snapshot cache state"
  )
  const row = rowArrayFromResult(result)[0]
  if (!row || typeof row.catalog_fingerprint !== "string") return null

  let tables: string[] = []
  try {
    const parsed = JSON.parse(row.tables_json as string)
    if (Array.isArray(parsed)) tables = parsed.filter((v): v is string => typeof v === "string")
  } catch {
    /* ignore */
  }

  return {
    catalogFingerprint: row.catalog_fingerprint,
    tables,
    loadedFileCount: Number(row.loaded_file_count ?? 0),
  }
}

export async function getExistingTableNames(connector: Connector): Promise<Set<string>> {
  const result = await withTimeout(
    connector.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
    ),
    20_000,
    "checking cached tables"
  )
  return new Set(
    rowArrayFromResult(result)
      .map((r) => String(r.table_name ?? ""))
      .filter(Boolean)
  )
}

export async function persistSnapshotCacheState(
  connector: Connector,
  fingerprint: string,
  tables: string[],
  fileCount: number
): Promise<void> {
  await ensureCacheStateTable(connector)
  await withTimeout(
    connector.query(`DELETE FROM ${CACHE_STATE_TABLE} WHERE state_key = 'latest'`),
    20_000,
    "resetting snapshot cache state"
  )
  await withTimeout(
    connector.query(`INSERT INTO ${CACHE_STATE_TABLE}
      (state_key, catalog_fingerprint, tables_json, loaded_file_count, updated_at)
      VALUES (
        'latest',
        '${escapeSqlString(fingerprint)}',
        '${escapeSqlString(JSON.stringify(tables))}',
        ${fileCount},
        current_timestamp
      )`),
    20_000,
    "saving snapshot cache state"
  )
}
