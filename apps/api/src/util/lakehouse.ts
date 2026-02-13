// Utility functions for the serverless lakehouse

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
 * Lakehouse source types
 */
export type LakehouseSource = "usage" | "verification" | "metadata"

/**
 * Prefix for raw NDJSON files (per project, per day, per source)
 * Uses Hive-style partitioning: year=YYYY/month=MM/day=DD/customer=ID
 * Path: lakehouse/{projectId}/raw/{source}/year={year}/month={month}/day={day}/
 */
export function getLakehouseRawPrefix(
  projectId: string,
  source: LakehouseSource,
  day: string,
  customerId?: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  const base = `lakehouse/${projectId}/raw/${source}/year=${year}/month=${month}/day=${d}/`
  return customerId ? `${base}customer=${customerId}/` : base
}

/**
 * Key for a raw NDJSON file (immutable batch)
 * Path: lakehouse/{projectId}/raw/{source}/{year}/{month}/{day}/part-{suffix}.ndjson
 */
export function getLakehouseRawKey(
  projectId: string,
  source: LakehouseSource,
  day: string,
  customerId: string,
  suffix: string
): string {
  return `${getLakehouseRawPrefix(projectId, source, day, customerId)}part-${suffix}.ndjson`
}

/**
 * Prefix for compacted NDJSON files (per project, per day, per source)
 * Uses Hive-style partitioning: year=YYYY/month=MM/day=DD
 * Path: lakehouse/{projectId}/compacted/{source}/year={year}/month={month}/day={day}/
 */
export function getLakehouseCompactedPrefix(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `lakehouse/${projectId}/compacted/${source}/year=${year}/month=${month}/day=${d}/`
}

/**
 * Key for a compacted NDJSON file (daily compaction result)
 * Path: lakehouse/{projectId}/compacted/{source}/{year}/{month}/{day}/data.ndjson
 */
export function getLakehouseCompactedKey(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  return `${getLakehouseCompactedPrefix(projectId, source, day)}data.ndjson`
}

export function getLakehouseCompactionMarkerKey(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  return `${getLakehouseCompactedPrefix(projectId, source, day)}_raw-consumed.json`
}

export function getLakehouseLegacyRawPrefix(
  projectId: string,
  source: LakehouseSource,
  day: string,
  customerId?: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  const base = `lakehouse/${projectId}/raw/${source}/${year}/${month}/${d}/`
  return customerId ? `${base}customer=${customerId}/` : base
}

export function getLakehouseLegacyCompactedPrefix(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `lakehouse/${projectId}/compacted/${source}/${year}/${month}/${d}/`
}

export function getLakehouseLegacyCompactionMarkerKey(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  return `${getLakehouseLegacyCompactedPrefix(projectId, source, day)}_raw-consumed.json`
}

export function getLakehouseIndexKey(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `lakehouse/${projectId}/index/year=${year}/month=${month}/day=${d}/${source}.json`
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return toBase64Url(new Uint8Array(sig))
}

export async function signLakehouseKey(secret: string, key: string, exp: number): Promise<string> {
  return hmacSha256Base64Url(secret, `${key}|${exp}`)
}

export async function verifyLakehouseSignature(params: {
  secret: string
  key: string
  exp: number
  sig: string
}): Promise<boolean> {
  const expected = await signLakehouseKey(params.secret, params.key, params.exp)
  return expected === params.sig
}
