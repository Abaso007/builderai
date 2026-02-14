import type { LakehouseSource } from "./schemas"

interface CatalogPreparedStatement {
  bind(...values: unknown[]): CatalogPreparedStatement
}

interface D1BatchResult {
  results?: unknown[]
}

export interface LakehouseCatalogDatabase {
  exec(query: string): Promise<unknown>
  prepare(query: string): CatalogPreparedStatement
  batch(statements: unknown[]): Promise<D1BatchResult[]>
}

const initializedCatalogs = new WeakSet<LakehouseCatalogDatabase>()

export type CatalogFileKind = "raw" | "compact"

export interface CatalogManifestFile {
  key: string
  day: string
  source: LakehouseSource
  bytes: number
  etag?: string
  uploadedAt: string
  kind: CatalogFileKind
  customerId?: string
}

export interface CatalogRawPart {
  key: string
  projectId: string
  source: LakehouseSource
  day: string
  customerId: string
  bytes: number
  etag?: string
  uploadedAt: string
}

export async function ensureLakehouseCatalogSchema(db: LakehouseCatalogDatabase): Promise<void> {
  if (initializedCatalogs.has(db)) {
    return
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS lakehouse_raw_parts (
      key TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      day TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      etag TEXT,
      uploaded_at TEXT NOT NULL,
      consumed_at TEXT,
      compacted_key TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_lakehouse_raw_parts_partition
      ON lakehouse_raw_parts(project_id, source, day, customer_id);

    CREATE INDEX IF NOT EXISTS idx_lakehouse_raw_parts_unconsumed
      ON lakehouse_raw_parts(project_id, source, day, consumed_at);

    CREATE TABLE IF NOT EXISTS lakehouse_compacted_parts (
      key TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      day TEXT NOT NULL,
      customer_id TEXT,
      bytes INTEGER NOT NULL,
      etag TEXT,
      uploaded_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_lakehouse_compacted_parts_partition
      ON lakehouse_compacted_parts(project_id, source, day, customer_id, active);

    CREATE TABLE IF NOT EXISTS lakehouse_compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      day TEXT NOT NULL,
      compacted_key TEXT NOT NULL,
      compacted_at TEXT NOT NULL,
      source_file_count INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      invalid_lines INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lakehouse_metadata_registry (
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata_key TEXT NOT NULL,
      value_type TEXT NOT NULL,
      pii_class TEXT NOT NULL DEFAULT 'unknown',
      is_allowed INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (project_id, source, metadata_key)
    );
  `)

  initializedCatalogs.add(db)
}

export async function insertLakehouseRawParts(
  db: LakehouseCatalogDatabase,
  parts: CatalogRawPart[]
): Promise<void> {
  if (parts.length === 0) {
    return
  }

  await ensureLakehouseCatalogSchema(db)

  const statements = parts.map((part) =>
    db
      .prepare(`
        INSERT INTO lakehouse_raw_parts
          (key, project_id, source, day, customer_id, bytes, etag, uploaded_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO NOTHING
      `)
      .bind(
        part.key,
        part.projectId,
        part.source,
        part.day,
        part.customerId,
        part.bytes,
        part.etag ?? null,
        part.uploadedAt
      )
  )

  await db.batch(statements)
}

export async function registerLakehouseCompaction(params: {
  db: LakehouseCatalogDatabase
  projectId: string
  source: LakehouseSource
  day: string
  compactedKey: string
  compactedBytes: number
  compactedEtag?: string
  compactedUploadedAt: string
  consumedRawKeys: string[]
  lineCount: number
  invalidLines: number
}): Promise<void> {
  await ensureLakehouseCatalogSchema(params.db)

  const statements: CatalogPreparedStatement[] = []

  statements.push(
    params.db
      .prepare(`
        INSERT INTO lakehouse_compacted_parts
          (key, project_id, source, day, customer_id, bytes, etag, uploaded_at, active)
        VALUES
          (?, ?, ?, ?, NULL, ?, ?, ?, 1)
        ON CONFLICT(key) DO UPDATE SET
          bytes = excluded.bytes,
          etag = excluded.etag,
          uploaded_at = excluded.uploaded_at,
          active = 1
      `)
      .bind(
        params.compactedKey,
        params.projectId,
        params.source,
        params.day,
        params.compactedBytes,
        params.compactedEtag ?? null,
        params.compactedUploadedAt
      )
  )

  statements.push(
    params.db
      .prepare(`
        INSERT INTO lakehouse_compactions
          (project_id, source, day, compacted_key, compacted_at, source_file_count, line_count, bytes, invalid_lines)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        params.projectId,
        params.source,
        params.day,
        params.compactedKey,
        params.compactedUploadedAt,
        params.consumedRawKeys.length,
        params.lineCount,
        params.compactedBytes,
        params.invalidLines
      )
  )

  for (const rawKey of params.consumedRawKeys) {
    statements.push(
      params.db
        .prepare(`
          UPDATE lakehouse_raw_parts
          SET consumed_at = ?, compacted_key = ?
          WHERE key = ?
        `)
        .bind(params.compactedUploadedAt, params.compactedKey, rawKey)
    )
  }

  await params.db.batch(statements)
}

export async function listLakehouseProjectsForDay(params: {
  db: LakehouseCatalogDatabase
  day: string
}): Promise<string[]> {
  await ensureLakehouseCatalogSchema(params.db)

  const stmt = params.db
    .prepare(`
      SELECT DISTINCT project_id
      FROM lakehouse_raw_parts
      WHERE day = ?
        AND consumed_at IS NULL
      ORDER BY project_id ASC
    `)
    .bind(params.day)

  const results = await params.db.batch([stmt])
  const rows = (results[0]?.results ?? []) as Array<{ project_id?: string | null }>
  return rows.map((row) => row.project_id).filter((value): value is string => !!value)
}

export async function listLakehouseRawKeysForDaySource(params: {
  db: LakehouseCatalogDatabase
  projectId: string
  source: LakehouseSource
  day: string
}): Promise<string[]> {
  await ensureLakehouseCatalogSchema(params.db)

  const stmt = params.db
    .prepare(`
      SELECT key
      FROM lakehouse_raw_parts
      WHERE project_id = ?
        AND source = ?
        AND day = ?
        AND consumed_at IS NULL
      ORDER BY key ASC
    `)
    .bind(params.projectId, params.source, params.day)

  const results = await params.db.batch([stmt])
  const rows = (results[0]?.results ?? []) as Array<{ key?: string | null }>
  return rows.map((row) => row.key).filter((value): value is string => !!value)
}

function toInClausePlaceholders(values: readonly string[]): string {
  return values.map(() => "?").join(",")
}

export async function resolveLakehouseManifestFiles(params: {
  db: LakehouseCatalogDatabase
  projectId: string
  sources: LakehouseSource[]
  days: string[]
  customerId?: string
}): Promise<CatalogManifestFile[]> {
  await ensureLakehouseCatalogSchema(params.db)

  if (params.sources.length === 0 || params.days.length === 0) {
    return []
  }

  const sourceIn = toInClausePlaceholders(params.sources)
  const dayIn = toInClausePlaceholders(params.days)
  const baseBinds = [params.projectId, ...params.sources, ...params.days]

  const compactWhereCustomer = params.customerId
    ? " AND (customer_id IS NULL OR customer_id = ?)"
    : ""
  const rawWhereCustomer = params.customerId ? " AND customer_id = ?" : ""

  const compactStmt = params.db
    .prepare(`
      SELECT key, day, source, bytes, etag, uploaded_at, customer_id
      FROM lakehouse_compacted_parts
      WHERE project_id = ?
        AND source IN (${sourceIn})
        AND day IN (${dayIn})
        AND active = 1
        ${compactWhereCustomer}
      ORDER BY day DESC, source ASC, uploaded_at DESC, key ASC
    `)
    .bind(...baseBinds, ...(params.customerId ? [params.customerId] : []))

  const rawStmt = params.db
    .prepare(`
      SELECT key, day, source, bytes, etag, uploaded_at, customer_id
      FROM lakehouse_raw_parts
      WHERE project_id = ?
        AND source IN (${sourceIn})
        AND day IN (${dayIn})
        AND consumed_at IS NULL
        ${rawWhereCustomer}
      ORDER BY day DESC, source ASC, uploaded_at DESC, key ASC
    `)
    .bind(...baseBinds, ...(params.customerId ? [params.customerId] : []))

  const batchResults = await params.db.batch([compactStmt, rawStmt])
  const compactRes = batchResults[0]
  const rawRes = batchResults[1]

  type Row = {
    key: string
    day: string
    source: LakehouseSource
    bytes: number
    etag?: string | null
    uploaded_at: string
    customer_id?: string | null
  }

  const compactRows = (compactRes?.results ?? []) as Row[]
  const rawRows = (rawRes?.results ?? []) as Row[]

  const files: CatalogManifestFile[] = []

  for (const row of compactRows) {
    files.push({
      key: row.key,
      day: row.day,
      source: row.source,
      bytes: Number(row.bytes ?? 0),
      etag: row.etag ?? undefined,
      uploadedAt: row.uploaded_at,
      kind: "compact",
      customerId: row.customer_id ?? undefined,
    })
  }

  for (const row of rawRows) {
    files.push({
      key: row.key,
      day: row.day,
      source: row.source,
      bytes: Number(row.bytes ?? 0),
      etag: row.etag ?? undefined,
      uploadedAt: row.uploaded_at,
      kind: "raw",
      customerId: row.customer_id ?? undefined,
    })
  }

  return files
}
