import type { LakehouseSource } from "./schemas"

export function getDaysAgoUTC(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().split("T")[0] ?? ""
}

export function getDateRangeUTC(range: "24h" | "7d" | "30d" | "90d"): string[] {
  const days = range === "24h" ? 1 : Number.parseInt(range)
  const dates: string[] = []
  for (let i = 0; i < days; i += 1) {
    dates.push(getDaysAgoUTC(i))
  }
  return dates
}

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

export function getLakehouseRawPrefix(
  projectId: string,
  source: LakehouseSource,
  day: string,
  customerId?: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  const base = `lakehouse/raw/${projectId}/${source}/year=${year}/month=${month}/day=${d}/`
  return customerId ? `${base}customer=${customerId}/` : base
}

export function getLakehouseRawKey(
  projectId: string,
  source: LakehouseSource,
  day: string,
  customerId: string,
  suffix: string
): string {
  return `${getLakehouseRawPrefix(projectId, source, day, customerId)}part-${suffix}.ndjson`
}

export function getLakehouseCompactedPrefix(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `lakehouse/compacted/${projectId}/${source}/year=${year}/month=${month}/day=${d}/`
}

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
  const base = `lakehouse/raw/${projectId}/${source}/${year}/${month}/${d}/`
  return customerId ? `${base}customer=${customerId}/` : base
}

export function getLakehouseLegacyCompactedPrefix(
  projectId: string,
  source: LakehouseSource,
  day: string
): string {
  const { year, month, day: d } = dayToPathParts(day)
  return `lakehouse/compacted/${projectId}/${source}/${year}/${month}/${d}/`
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
  return `lakehouse/index/${projectId}/year=${year}/month=${month}/day=${d}/${source}.json`
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0)
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
