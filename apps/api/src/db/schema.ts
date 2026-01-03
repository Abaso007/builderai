import { index, integer, numeric, sqliteTableCreator, text, unique } from "drizzle-orm/sqlite-core"

export const version = "unpricedo_v1"

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
    idempotenceKey: text().notNull(),
    requestId: text().notNull(),
    featureSlug: text().notNull(),
    customerId: text().notNull(),
    projectId: text().notNull(),
    // time when the usage should be reported
    timestamp: integer().notNull(),
    createdAt: integer().notNull(),
    usage: numeric(),
    metadata: text(),
    // 0 = not deleted, 1 = deleted
    deleted: integer().notNull().default(0),
  },
  (table) => [
    // Indexes for common queries
    index("usage_records_feature_idx").on(table.featureSlug),
    index("usage_records_timestamp_idx").on(table.timestamp),
    unique("usage_idempotence_key_idx").on(table.idempotenceKey),
  ]
)

export const verifications = pgTableProject(
  "verifications",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    requestId: text().notNull(),
    projectId: text().notNull(),
    deniedReason: text(),
    timestamp: integer().notNull(),
    createdAt: integer().notNull(),
    latency: numeric(),
    featureSlug: text().notNull(),
    customerId: text().notNull(),
    metadata: text(),
    allowed: integer().notNull().default(0),
  },
  (table) => [index("verifications_feature_idx").on(table.featureSlug)]
)
