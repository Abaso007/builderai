import {
  index,
  integer,
  numeric,
  primaryKey,
  sqliteTableCreator,
  text,
  unique,
} from "drizzle-orm/sqlite-core"

export const version = "usagelimiter_v1"

export const pgTableProject = sqliteTableCreator((name) => `${version}_${name}`)

/**
 * USAGE BUFFER
 *
 * Temporary storage for usage events before they're flushed to Tinybird.
 * Records are DELETED after successful flush (not marked as flushed).
 *
 * Why delete instead of mark?
 * - Simpler: no status to track
 * - Smaller: buffer stays small
 * - Idempotent: Tinybird dedupes by ID anyway
 */
export const usageRecords = pgTableProject(
  "usage_records",
  {
    // ULID: Unique, time-sortable identifier
    // Example: "01HZXK7VQGPXR3Y8JMWF2D4N6B"
    // First 10 chars encode timestamp, rest is random
    // Lexicographic sort = chronological sort
    id: text("id").primaryKey(), // ULID
    idempotence_key: text().notNull(),
    request_id: text().notNull(),
    feature_slug: text().notNull(),
    customer_id: text().notNull(),
    project_id: text().notNull(),
    // time when the usage should be reported
    timestamp: integer().notNull(),
    created_at: integer().notNull(),
    usage: numeric(),
    metadata: text(),
    cost: numeric(),
    rate_amount: numeric(),
    rate_currency: text(),
    entitlement_snapshot_id: text(),
    entitlement_version: text(),
    entitlement_feature_type: text(),
    entitlement_limit: integer(),
    entitlement_overage_strategy: text(),
    entitlement_effective_at: integer(),
    entitlement_expires_at: integer(),
    entitlement_snapshot: text(),
    // 0 = not deleted, 1 = deleted
    deleted: integer().notNull().default(0),
    // first-class analytics columns
    country: text().default("UNK"),
    region: text().default("UNK"),
    action: text(),
    key_id: text(),
  },
  (table) => [
    // Indexes for common queries
    index("usage_records_feature_idx").on(table.feature_slug),
    index("usage_records_timestamp_idx").on(table.timestamp),
    unique("usage_idempotence_key_idx").on(table.idempotence_key),
  ]
)

export const verifications = pgTableProject(
  "verifications",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    request_id: text().notNull(),
    project_id: text().notNull(),
    denied_reason: text(),
    timestamp: integer().notNull(),
    created_at: integer().notNull(),
    latency: numeric(),
    feature_slug: text().notNull(),
    customer_id: text().notNull(),
    metadata: text(),
    usage: numeric(),
    remaining: numeric(),
    entitlement_snapshot_id: text(),
    entitlement_version: text(),
    entitlement_feature_type: text(),
    entitlement_limit: integer(),
    entitlement_overage_strategy: text(),
    entitlement_effective_at: integer(),
    entitlement_expires_at: integer(),
    entitlement_snapshot: text(),
    allowed: integer().notNull().default(0),
    // first-class analytics columns
    country: text().default("UNK"),
    region: text().default("UNK"),
    action: text(),
    key_id: text(),
  },
  (table) => [index("verifications_feature_idx").on(table.feature_slug)]
)

export const usageAggregates = pgTableProject(
  "usage_aggregates",
  {
    bucket_start: integer().notNull(),
    bucket_size_seconds: integer().notNull(),
    feature_slug: text().notNull(),
    usage_count: integer().notNull().default(0),
    total_usage: numeric().notNull().default("0"),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.bucket_start, table.bucket_size_seconds, table.feature_slug],
    }),
    index("usage_aggregates_bucket_idx").on(table.bucket_size_seconds, table.bucket_start),
  ]
)

export const verificationAggregates = pgTableProject(
  "verification_aggregates",
  {
    bucket_start: integer().notNull(),
    bucket_size_seconds: integer().notNull(),
    feature_slug: text().notNull(),
    verification_count: integer().notNull().default(0),
    allowed_count: integer().notNull().default(0),
    denied_count: integer().notNull().default(0),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.bucket_start, table.bucket_size_seconds, table.feature_slug],
    }),
    index("verification_aggregates_bucket_idx").on(table.bucket_size_seconds, table.bucket_start),
  ]
)

export const reportUsageAggregates = pgTableProject(
  "report_usage_aggregates",
  {
    bucket_start: integer().notNull(),
    bucket_size_seconds: integer().notNull(),
    feature_slug: text().notNull(),
    report_usage_count: integer().notNull().default(0),
    limit_exceeded_count: integer().notNull().default(0),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.bucket_start, table.bucket_size_seconds, table.feature_slug],
    }),
    index("report_usage_aggregates_bucket_idx").on(table.bucket_size_seconds, table.bucket_start),
  ]
)
