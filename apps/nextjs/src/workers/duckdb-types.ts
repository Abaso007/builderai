/**
 * Shared types for DuckDB worker communication
 *
 * Schema and data source definitions live here so the worker stays generic:
 * it creates tables and inserts rows from these definitions only.
 * Add new event types by adding a new DataSourceId and entry in DATA_SOURCES.
 */

export interface FileToLoad {
  url: string
  key?: string
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  executionTimeMs: number
}

// ---------------------------------------------------------------------------
// Schema abstraction (single place for table structure and parsing contract)
// ---------------------------------------------------------------------------

/** DuckDB column types used in CREATE TABLE and value formatting. */
export type DuckDBColumnType = "VARCHAR" | "TIMESTAMP" | "DOUBLE" | "JSON" | "BIGINT"

/** Definition of one column: name, SQL type, and optional JSON key for NDJSON parsing. */
export interface ColumnDef {
  name: string
  sqlType: DuckDBColumnType
  /** Key to read from parsed JSON; defaults to column name. */
  jsonKey?: string
}

/** Full definition of a data source: table name and column list. */
export interface DataSourceDef {
  id: DataSourceId
  /** Table name in DuckDB (usually same as id). */
  tableName: string
  columns: ColumnDef[]
}

/** Known event table / data source IDs. Add new ones when you add new event types. */
export type DataSourceId = "usage_events" | "verification_events"

/**
 * Usage events schema aligned with internal/analytics featureUsageSchemaV1.
 * NDJSON keys: id, idempotence_key, feature_slug, request_id, project_id, customer_id,
 * timestamp (unix ms), usage, created_at, deleted, meta_id, metadata, country, region, action, key_id.
 */
const USAGE_EVENTS_COLUMNS: ColumnDef[] = [
  { name: "id", sqlType: "VARCHAR", jsonKey: "id" },
  { name: "idempotence_key", sqlType: "VARCHAR", jsonKey: "idempotence_key" },
  { name: "feature_slug", sqlType: "VARCHAR", jsonKey: "feature_slug" },
  { name: "request_id", sqlType: "VARCHAR", jsonKey: "request_id" },
  { name: "project_id", sqlType: "VARCHAR", jsonKey: "project_id" },
  { name: "customer_id", sqlType: "VARCHAR", jsonKey: "customer_id" },
  { name: "timestamp", sqlType: "BIGINT", jsonKey: "timestamp" },
  { name: "usage", sqlType: "BIGINT", jsonKey: "usage" },
  { name: "created_at", sqlType: "BIGINT", jsonKey: "created_at" },
  { name: "deleted", sqlType: "BIGINT", jsonKey: "deleted" },
  { name: "meta_id", sqlType: "BIGINT", jsonKey: "meta_id" },
  { name: "metadata", sqlType: "JSON", jsonKey: "metadata" },
  { name: "country", sqlType: "VARCHAR", jsonKey: "country" },
  { name: "region", sqlType: "VARCHAR", jsonKey: "region" },
  { name: "action", sqlType: "VARCHAR", jsonKey: "action" },
  { name: "key_id", sqlType: "VARCHAR", jsonKey: "key_id" },
]

/**
 * Verification events schema aligned with internal/analytics featureVerificationSchemaV1.
 * NDJSON keys: project_id, denied_reason, allowed, timestamp, created_at, latency,
 * feature_slug, customer_id, request_id, region, meta_id, metadata, country, action, key_id.
 */
const VERIFICATION_EVENTS_COLUMNS: ColumnDef[] = [
  { name: "project_id", sqlType: "VARCHAR", jsonKey: "project_id" },
  { name: "denied_reason", sqlType: "VARCHAR", jsonKey: "denied_reason" },
  { name: "allowed", sqlType: "BIGINT", jsonKey: "allowed" },
  { name: "timestamp", sqlType: "BIGINT", jsonKey: "timestamp" },
  { name: "created_at", sqlType: "BIGINT", jsonKey: "created_at" },
  { name: "latency", sqlType: "DOUBLE", jsonKey: "latency" },
  { name: "feature_slug", sqlType: "VARCHAR", jsonKey: "feature_slug" },
  { name: "customer_id", sqlType: "VARCHAR", jsonKey: "customer_id" },
  { name: "request_id", sqlType: "VARCHAR", jsonKey: "request_id" },
  { name: "region", sqlType: "VARCHAR", jsonKey: "region" },
  { name: "meta_id", sqlType: "BIGINT", jsonKey: "meta_id" },
  { name: "metadata", sqlType: "JSON", jsonKey: "metadata" },
  { name: "country", sqlType: "VARCHAR", jsonKey: "country" },
  { name: "action", sqlType: "VARCHAR", jsonKey: "action" },
  { name: "key_id", sqlType: "VARCHAR", jsonKey: "key_id" },
]

/** Registry of all data sources: single source of truth for schema and table creation. */
export const DATA_SOURCES: Record<DataSourceId, DataSourceDef> = {
  usage_events: {
    id: "usage_events",
    tableName: "usage_events",
    columns: USAGE_EVENTS_COLUMNS,
  },
  verification_events: {
    id: "verification_events",
    tableName: "verification_events",
    columns: VERIFICATION_EVENTS_COLUMNS,
  },
}

/** All data source IDs (derived from registry). */
export const DATA_SOURCE_IDS: DataSourceId[] = Object.keys(DATA_SOURCES) as DataSourceId[]

/** Build CREATE TABLE SQL for a data source. Used by worker on init. */
export function buildCreateTableSQL(def: DataSourceDef): string {
  const parts = def.columns.map((c) => `${c.name} ${c.sqlType}`)
  return `CREATE TABLE IF NOT EXISTS ${def.tableName} (${parts.join(", ")})`
}

/** Escape single-quoted string for SQL. */
export function escapeSqlValue(s: string): string {
  return s.replace(/'/g, "''")
}

/** Format one value for SQL literal (no column name). */
export function formatValueForSQL(value: unknown, sqlType: DuckDBColumnType): string {
  if (value == null) return "NULL"
  switch (sqlType) {
    case "VARCHAR":
      return `'${escapeSqlValue(String(value))}'`
    case "TIMESTAMP":
      return `'${escapeSqlValue(String(value))}'::TIMESTAMP`
    case "DOUBLE":
    case "BIGINT":
      return String(Number(value))
    case "JSON":
      return typeof value === "string"
        ? `'${escapeSqlValue(value)}'::JSON`
        : `'${escapeSqlValue(JSON.stringify(value))}'::JSON`
    default:
      return `'${escapeSqlValue(String(value))}'`
  }
}

/** Format a parsed row as a single VALUES (...) clause for INSERT. */
export function formatRowForInsert(row: Record<string, unknown>, def: DataSourceDef): string {
  const values = def.columns.map((col) => {
    const raw = row[col.name]
    const value =
      col.sqlType === "DOUBLE" && typeof raw !== "number"
        ? (Number(raw) ?? 0)
        : col.sqlType === "JSON" && raw != null && typeof raw !== "string"
          ? JSON.stringify(raw)
          : raw
    return formatValueForSQL(value, col.sqlType)
  })
  return `(${values.join(", ")})`
}

/** Parse one NDJSON line into a row object keyed by column name, or null if invalid. */
export function parseNdjsonRow(line: string, def: DataSourceDef): Record<string, unknown> | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>
    const row: Record<string, unknown> = {}
    for (const col of def.columns) {
      const key = col.jsonKey ?? col.name
      let value = event[key]
      if (value === undefined) {
        if (col.sqlType === "VARCHAR" || col.sqlType === "TIMESTAMP") value = ""
        else if (col.sqlType === "DOUBLE" || col.sqlType === "BIGINT") value = 0
        else value = null
      }
      if (col.sqlType === "TIMESTAMP" && !value) value = new Date().toISOString()
      if (col.sqlType === "JSON" && value != null && typeof value !== "string")
        value = JSON.stringify(value)
      row[col.name] = value
    }
    return row
  } catch {
    return null
  }
}

export interface DuckDBWorkerAPI {
  init(): Promise<void>
  /** Load files into the given table. Defaults to usage_events for backward compatibility. */
  loadFiles(
    files: FileToLoad[],
    projectId: string,
    targetTable?: DataSourceId
  ): Promise<{ loaded: number; totalEvents: number }>
  runQuery(sql: string): Promise<QueryResult>
  /** If table is given, returns count for that table only; otherwise total across all tables. */
  getLoadedFileCount(table?: DataSourceId): Promise<number>
  /** If table is given, clears only that table; otherwise clears all event tables. */
  clearData(table?: DataSourceId): Promise<void>
}

/** Query templates use this placeholder so we can target any table. */
const TABLE_PLACEHOLDER = "__TABLE__"
/** Placeholder for timestamp expression: BIGINT unix ms -> date part for grouping. */
const TS_DAY = "strftime(epoch_ms(timestamp)::TIMESTAMP, '%Y-%m-%d')"
const TS_HOUR = "strftime(epoch_ms(timestamp)::TIMESTAMP, '%Y-%m-%d %H:00')"
const TS_MINUTE = "strftime(epoch_ms(timestamp)::TIMESTAMP, '%Y-%m-%d %H:%M')"

/** Predefined queries for usage_events (featureUsageSchemaV1: feature_slug, usage). */
const USAGE_QUERY_TEMPLATES = {
  totalEvents: `SELECT COUNT(*) as total_events FROM ${TABLE_PLACEHOLDER}`,

  eventsByType: `
    SELECT
      feature_slug,
      COUNT(*) as count,
      SUM(usage) as total_usage
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY feature_slug
    ORDER BY count DESC
  `,

  eventsByDay: `
    SELECT
      ${TS_DAY} as day,
      COUNT(*) as count,
      SUM(usage) as total_usage
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY day
    ORDER BY day DESC
  `,

  eventsByHour: `
    SELECT
      ${TS_HOUR} as hour,
      COUNT(*) as count
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY hour
    ORDER BY hour DESC
    LIMIT 48
  `,

  eventsByMinute: `
    SELECT
      ${TS_MINUTE} as minute,
      COUNT(*) as count
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY minute
    ORDER BY minute DESC
    LIMIT 60
  `,

  uniqueResources: `
    SELECT COUNT(DISTINCT customer_id) as unique_resources FROM ${TABLE_PLACEHOLDER}
  `,

  topResources: `
    SELECT
      feature_slug,
      COUNT(*) as event_count,
      SUM(usage) as total_usage
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY feature_slug
    ORDER BY total_usage DESC
    LIMIT 20
  `,

  quantityStats: `
    SELECT
      MIN(usage) as min_quantity,
      MAX(usage) as max_quantity,
      AVG(usage) as avg_quantity,
      SUM(usage) as total_quantity,
      COUNT(*) as event_count
    FROM ${TABLE_PLACEHOLDER}
  `,

  recentEvents: `
    SELECT * FROM ${TABLE_PLACEHOLDER}
    ORDER BY timestamp DESC
    LIMIT 100
  `,
} as const

/** Predefined queries for verification_events (featureVerificationSchemaV1: feature_slug, allowed, latency). */
const VERIFICATION_QUERY_TEMPLATES = {
  totalEvents: `SELECT COUNT(*) as total_events FROM ${TABLE_PLACEHOLDER}`,

  eventsByType: `
    SELECT
      feature_slug,
      COUNT(*) as count,
      SUM(allowed) as allowed_count,
      COUNT(*) - SUM(allowed) as denied_count
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY feature_slug
    ORDER BY count DESC
  `,

  eventsByDay: `
    SELECT
      ${TS_DAY} as day,
      COUNT(*) as count,
      SUM(allowed) as allowed_count
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY day
    ORDER BY day DESC
  `,

  eventsByHour: `
    SELECT
      ${TS_HOUR} as hour,
      COUNT(*) as count
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY hour
    ORDER BY hour DESC
    LIMIT 48
  `,

  eventsByMinute: `
    SELECT
      ${TS_MINUTE} as minute,
      COUNT(*) as count
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY minute
    ORDER BY minute DESC
    LIMIT 60
  `,

  uniqueResources: `
    SELECT COUNT(DISTINCT customer_id) as unique_resources FROM ${TABLE_PLACEHOLDER}
  `,

  topResources: `
    SELECT
      feature_slug,
      COUNT(*) as event_count,
      SUM(allowed) as allowed_count,
      AVG(latency) as avg_latency_ms
    FROM ${TABLE_PLACEHOLDER}
    GROUP BY feature_slug
    ORDER BY event_count DESC
    LIMIT 20
  `,

  quantityStats: `
    SELECT
      COUNT(*) as event_count,
      SUM(allowed) as allowed_count,
      AVG(latency) as avg_latency_ms,
      MIN(latency) as min_latency_ms,
      MAX(latency) as max_latency_ms
    FROM ${TABLE_PLACEHOLDER}
  `,

  recentEvents: `
    SELECT * FROM ${TABLE_PLACEHOLDER}
    ORDER BY timestamp DESC
    LIMIT 100
  `,
} as const

const PREDEFINED_QUERY_TEMPLATES = USAGE_QUERY_TEMPLATES

export type PredefinedQueryName = keyof typeof PREDEFINED_QUERY_TEMPLATES

const QUERY_TEMPLATES_BY_SOURCE: Record<DataSourceId, Record<PredefinedQueryName, string>> = {
  usage_events: USAGE_QUERY_TEMPLATES,
  verification_events: VERIFICATION_QUERY_TEMPLATES,
}

/** Get SQL for a predefined query targeting the given data source (uses schema registry table name). */
export function getPredefinedQuery(
  name: PredefinedQueryName,
  dataSourceId: DataSourceId = "usage_events"
): string {
  const templates = QUERY_TEMPLATES_BY_SOURCE[dataSourceId]
  const template = templates[name]
  if (!template) return ""
  const tableName = DATA_SOURCES[dataSourceId].tableName
  return template.replace(new RegExp(TABLE_PLACEHOLDER.replace(/\./g, "\\."), "g"), tableName)
}

/** Legacy: queries defaulting to usage_events (for callers that don't pass table yet). */
export const PREDEFINED_QUERIES = Object.fromEntries(
  (Object.keys(PREDEFINED_QUERY_TEMPLATES) as PredefinedQueryName[]).map((name) => [
    name,
    getPredefinedQuery(name, "usage_events"),
  ])
) as Record<PredefinedQueryName, string>
