// Utility functions for the serverless lakehouse

/**
 * Get today's date in YYYY-MM-DD format (UTC)
 */
export function getTodayUTC(): string {
  return new Date().toISOString().split("T")[0] ?? ""
}

/**
 * Get yesterday's date in YYYY-MM-DD format (UTC)
 */
export function getYesterdayUTC(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().split("T")[0] ?? ""
}

/**
 * Get a date N days ago in YYYY-MM-DD format (UTC)
 */
export function getDaysAgoUTC(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().split("T")[0] ?? ""
}

/**
 * Get array of dates for a range
 */
export function getDateRangeUTC(range: "24h" | "7d" | "30d" | "90d"): string[] {
  const days = range === "24h" ? 1 : Number.parseInt(range)
  const dates: string[] = []
  for (let i = 0; i < days; i++) {
    dates.push(getDaysAgoUTC(i))
  }
  return dates
}

/**
 * Split YYYY-MM-DD into path parts (year, zero-padded month, zero-padded day)
 * e.g. "2026-02-02" -> { year: "2026", month: "02", day: "02" }
 */
export function dayToPathParts(day: string): { year: string; month: string; day: string } {
  const [year, month, dayNum] = day.split("-")
  if (!year || !month || !dayNum) {
    throw new Error(`Invalid day format (expected YYYY-MM-DD): ${day}`)
  }
  return {
    year,
    month: month.padStart(2, "0"),
    day: dayNum.padStart(2, "0"),
  }
}

/**
 * Generate R2 key for raw flush file
 * Path: raw/{tenantId}/{year}/{month}/{day}/flush={ulid}.ndjson
 */
export function getRawFileKey(tenantId: string, day: string, ulid: string): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `raw/${tenantId}/${year}/${month}/${d}/flush=${ulid}.ndjson`
}

/**
 * Generate R2 key for compact file (one file per day in the same folder as flush files)
 * Path: raw/{tenantId}/{year}/{month}/{day}/compact.ndjson
 */
export function getCompactFileKey(tenantId: string, day: string): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `raw/${tenantId}/${year}/${month}/${d}/compact.ndjson`
}

/**
 * Generate R2 key for day manifest (legacy per-day layout)
 * Path: manifests/{tenantId}/{year}/{month}/{day}.json
 */
export function getManifestKey(tenantId: string, day: string): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `manifests/${tenantId}/${year}/${month}/${d}.json`
}

/**
 * R2 key for usage manifest (per project + customer, written by DO provider)
 * Path: {projectId}/{customerId}/usage_manifest.json
 */
export function getUsageManifestKey(projectId: string, customerId: string): string {
  return `${projectId}/${customerId}/usage_manifest.json`
}

/**
 * R2 key for verification manifest (per project + customer, written by DO provider)
 * Path: {projectId}/{customerId}/verification_manifest.json
 */
export function getVerificationManifestKey(projectId: string, customerId: string): string {
  return `${projectId}/${customerId}/verification_manifest.json`
}

/**
 * R2 key for metadata manifest (per project + customer, written by DO provider)
 * Path: {projectId}/{customerId}/metadata_manifest.json
 */
export function getMetadataManifestKey(projectId: string, customerId: string): string {
  return `${projectId}/${customerId}/metadata_manifest.json`
}

/**
 * Validate that an R2 key belongs to a tenant
 */
export function validateTenantKey(key: string, tenantId: string): boolean {
  // Must start with raw/{tenantId}/ or manifests/{tenantId}/
  return key.startsWith(`raw/${tenantId}/`) || key.startsWith(`manifests/${tenantId}/`)
}

/**
 * Parse range string to number of days
 */
export function parseRange(range: string): number {
  if (range === "24h") return 1
  const match = range.match(/^(\d+)d$/)
  if (match) return Number.parseInt(match[1] ?? "7")
  return 7 // default
}

/**
 * Hash a string using Web Crypto API (SHA-256, returns hex)
 */
export async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(str)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Simple sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
