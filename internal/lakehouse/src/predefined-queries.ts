// const verificationRawQuery = buildInlineLakehouseQuery({
//   from: { table: "verifications" },
//   select: [
//     { column: "id" },
//     { column: "customer_id" },
//     { column: "feature_slug" },
//     { column: "allowed" },
//     { column: "denied_reason" },
//     { column: "latency" },
//     { column: "timestamp" },
//   ],
//   orderBy: [{ column: { column: "timestamp" }, direction: "desc" }],
//   limit: 500,
// })

export const PREDEFINED_LAKEHOUSE_QUERIES = {
  allUsage: {
    label: "Usage (raw + metadata)",
    description: "All usage events with metadata tags",
    query: `WITH metadata_dedup AS (
  SELECT
    CAST(id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(payload) AS payload
  FROM metadata
  GROUP BY 1, 2, 3
)
SELECT
  u.*,
  CAST(m.payload AS VARCHAR) AS metadata_payload
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
    CAST(id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(payload) AS payload
  FROM metadata
  GROUP BY 1, 2, 3
),
joined AS (
  SELECT u.id, TRY_CAST(m.payload AS JSON) AS payload_json
  FROM usage u
  LEFT JOIN metadata_dedup m
    ON CAST(u.meta_id AS VARCHAR) = m.meta_id
    AND u.project_id = m.project_id
    AND u.customer_id = m.customer_id
  WHERE u.deleted = 0 AND m.payload IS NOT NULL
),
tags AS (
  SELECT unnest(json_keys(payload_json)) AS tag
  FROM joined
  WHERE payload_json IS NOT NULL
)
SELECT tag, COUNT(*) AS events
FROM tags
WHERE tag IS NOT NULL
  AND tag NOT IN ('cost', 'rate', 'rate_amount', 'rate_currency', 'rate_unit_size', 'usage', 'remaining')
GROUP BY tag
ORDER BY events DESC`,
  },
} as const

export type PredefinedLakehouseQueryKey = keyof typeof PREDEFINED_LAKEHOUSE_QUERIES

export const DEFAULT_LAKEHOUSE_QUERY = PREDEFINED_LAKEHOUSE_QUERIES.allUsage.query
