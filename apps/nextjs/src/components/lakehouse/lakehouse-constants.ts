import type { PredefinedLakehouseQueryKey } from "@unprice/lakehouse"
import type { ChartConfig } from "@unprice/ui/chart"

export const TABLE_CONFIG = {
  usage: { tableName: "usage", label: "Usage Events" },
  verification: { tableName: "verifications", label: "Verifications" },
  metadata: { tableName: "metadata", label: "Metadata" },
  entitlement_snapshot: { tableName: "entitlement_snapshots", label: "Entitlement Snapshots" },
} as const

export type TableSource = keyof typeof TABLE_CONFIG

export const CREDENTIAL_REFRESH_BUFFER = 60_000
export const EXPECTED_LAG_MINUTES = "1-5 min"

export const QUICK_QUERY_KEYS: PredefinedLakehouseQueryKey[] = [
  "allUsage",
  "usageByFeature",
  "verificationByFeature",
  "verificationWithMetadata",
  "metadataRaw",
  "usageByTagKey",
]

export const SECTION_MOTION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22, ease: "easeOut" },
} as const

export const USAGE_TREND_CHART_CONFIG: ChartConfig = {
  events: { label: "Events", color: "var(--chart-2)" },
  total_usage: { label: "Usage", color: "var(--chart-4)" },
}

export const VERIFICATION_TREND_CHART_CONFIG: ChartConfig = {
  allowed: { label: "Allowed", color: "var(--chart-4)" },
  denied: { label: "Denied", color: "var(--chart-1)" },
}

// ── Snapshot status badge config ─────────────────────────────────────────────

export type SnapshotStatusConfig = {
  label: string
  tone: string
  dotTone: string
  pulseTone: string
  pulse: boolean
}

export const SNAPSHOT_STATUS = {
  error: {
    label: "Needs attention",
    tone: "text-destructive",
    dotTone: "bg-destructive",
    pulseTone: "bg-destructive/60",
    pulse: false,
  },
  loading: {
    label: "Syncing snapshot",
    tone: "text-amber-700 dark:text-amber-400",
    dotTone: "bg-amber-500",
    pulseTone: "bg-amber-500/60",
    pulse: true,
  },
  idle: {
    // ← updated colors from this new version
    label: "Waiting for data",
    tone: "text-background-foreground",
    dotTone: "bg-background-border",
    pulseTone: "bg-background-bgActive",
    pulse: true,
  },
  ready: {
    label: "Snapshot synced",
    tone: "text-emerald-700 dark:text-emerald-400",
    dotTone: "bg-emerald-500",
    pulseTone: "bg-emerald-500/60",
    pulse: true,
  },
} as const satisfies Record<string, SnapshotStatusConfig>

// ── Analytics SQL ─────────────────────────────────────────────────────────────

export const USAGE_SUMMARY_QUERY = `
  SELECT COUNT(*) AS events, SUM(usage) AS total_usage,
         COUNT(DISTINCT customer_id) AS customers,
         COUNT(DISTINCT feature_slug) AS features
  FROM usage WHERE deleted = 0`

export const VERIFICATION_SUMMARY_QUERY = `
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) AS allowed,
         SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) AS denied,
         AVG(latency) AS avg_latency
  FROM verifications`

export const METADATA_COVERAGE_QUERY = `
  WITH metadata_dedup AS (
    SELECT CAST(id AS VARCHAR) AS meta_id, project_id, customer_id, MIN(payload) AS payload
    FROM metadata GROUP BY 1, 2, 3
  ),
  metadata_user_tags AS (
    SELECT meta_id, project_id, customer_id FROM metadata_dedup
    WHERE EXISTS (
      SELECT 1 FROM unnest(json_keys(payload)) AS t(tag)
      WHERE t.tag NOT IN ('cost','rate','rate_amount','rate_currency','rate_unit_size','usage','remaining')
    )
  )
  SELECT COUNT(DISTINCT u.id) AS total,
         COUNT(DISTINCT CASE WHEN m.meta_id IS NOT NULL THEN u.id END) AS with_meta
  FROM usage u
  LEFT JOIN metadata_user_tags m
    ON CAST(u.meta_id AS VARCHAR) = m.meta_id
   AND u.project_id = m.project_id
   AND u.customer_id = m.customer_id
  WHERE u.deleted = 0`

export const USAGE_TREND_QUERY = `
  WITH base AS (
    SELECT TRY_CAST("timestamp" AS DOUBLE) AS ts_num,
           TRY_CAST("timestamp" AS TIMESTAMP) AS ts_native, usage
    FROM usage WHERE deleted = 0
  ),
  normalized AS (
    SELECT CASE
      WHEN ts_native IS NOT NULL THEN CAST(ts_native AS TIMESTAMP)
      WHEN ts_num IS NULL        THEN NULL
      WHEN ts_num > 10000000000  THEN epoch_ms(CAST(ts_num AS BIGINT))
      ELSE epoch_ms(CAST(ts_num * 1000.0 AS BIGINT))
    END AS ts, usage FROM base
  )
  SELECT strftime(CAST(date_trunc('minute', ts) AS TIMESTAMP), '%Y-%m-%d %H:%M') AS minute,
         COUNT(*) AS events, SUM(usage) AS total_usage
  FROM normalized WHERE ts IS NOT NULL
  GROUP BY minute ORDER BY minute`

export const VERIFICATION_TREND_QUERY = `
  WITH base AS (
    SELECT TRY_CAST("timestamp" AS DOUBLE) AS ts_num,
           TRY_CAST("timestamp" AS TIMESTAMP) AS ts_native, allowed
    FROM verifications
  ),
  normalized AS (
    SELECT CASE
      WHEN ts_native IS NOT NULL THEN CAST(ts_native AS TIMESTAMP)
      WHEN ts_num IS NULL        THEN NULL
      WHEN ts_num > 10000000000  THEN epoch_ms(CAST(ts_num AS BIGINT))
      ELSE epoch_ms(CAST(ts_num * 1000.0 AS BIGINT))
    END AS ts, allowed FROM base
  )
  SELECT strftime(CAST(date_trunc('minute', ts) AS TIMESTAMP), '%Y-%m-%d %H:%M') AS minute,
         SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) AS allowed,
         SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) AS denied
  FROM normalized WHERE ts IS NOT NULL
  GROUP BY minute ORDER BY minute`
