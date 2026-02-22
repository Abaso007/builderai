import { PREDEFINED_LAKEHOUSE_QUERIES } from "@unprice/lakehouse"
import { TABLE_CONFIG, type TableSource } from "./lakehouse-constants"
import type { LakehouseFilePlan } from "./sqlrooms-store"

export async function withTimeout<T>(task: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let id: number | undefined
  const timer = new Promise<never>((_, reject) => {
    id = window.setTimeout(() => reject(new Error(`Timed out while ${label}.`)), ms)
  })
  try {
    return await (Promise.race([task, timer]) as Promise<T>)
  } finally {
    if (id !== undefined) window.clearTimeout(id)
  }
}

export const escapeSqlString = (v: string) => v.replaceAll("'", "''")

export const rowArrayFromResult = (result: unknown): Array<Record<string, unknown>> =>
  (result as { toArray?: () => Array<Record<string, unknown>> })?.toArray?.() ?? []

export function normalizeFileUrl(url: string): string {
  try {
    const { host, pathname } = new URL(url)
    return `${host}${pathname}`
  } catch {
    return url.split("?")[0] ?? url
  }
}

export function computeCatalogFingerprint(plan: LakehouseFilePlan): string {
  const tableFiles = (Object.keys(TABLE_CONFIG) as TableSource[])
    .map((src) => {
      const files = [...(plan.tableFiles[src] ?? [])].map(normalizeFileUrl).sort()
      return `${src}:${files.join(",")}`
    })
    .join("|")

  // ← null-safe: credentials may be absent for empty/public plans
  const credentialFingerprint = plan.credentials
    ? [
        plan.credentials.accessKeyId,
        plan.credentials.sessionToken,
        String(plan.credentials.expiration ?? ""),
      ].join("|")
    : "no-credentials"

  return [plan.targetEnv, plan.interval, credentialFingerprint, tableFiles].join("|")
}

export function computeExpirationMs(rawExpiration: unknown, ttlSeconds: unknown): number | null {
  const now = Date.now()

  if (typeof rawExpiration === "string") {
    const ts = Date.parse(rawExpiration)
    if (Number.isFinite(ts) && ts > 0) return ts
  }

  const n = Number(rawExpiration)
  if (Number.isFinite(n) && n > 0) {
    if (n > 1_000_000_000_000) return n
    if (n > 1_000_000_000) return n * 1000
    return now + n * 1000
  }

  const ttl = Number(ttlSeconds)
  if (Number.isFinite(ttl) && ttl > 0) return now + ttl * 1000

  return null
}

export function selectInitialQuery(tables: string[]): string {
  if (tables.includes("usage"))
    return tables.includes("metadata")
      ? PREDEFINED_LAKEHOUSE_QUERIES.allUsage.query
      : PREDEFINED_LAKEHOUSE_QUERIES.usageByFeature.query
  if (tables.includes("verifications"))
    return PREDEFINED_LAKEHOUSE_QUERIES.verificationByFeature.query
  if (tables.includes("metadata")) return PREDEFINED_LAKEHOUSE_QUERIES.metadataRaw.query
  if (tables.includes("entitlement_snapshots"))
    return PREDEFINED_LAKEHOUSE_QUERIES.entitlementSnapshotsRaw.query
  return ""
}

export function downloadArrowTableAsCsv(
  table: {
    toArray: () => Array<Record<string, unknown>>
    schema: { fields: Array<{ name: string }> }
  },
  filename = "lakehouse-query.csv"
): void {
  const rows = table.toArray()
  const columns = table.schema.fields.map((f) => f.name)
  // biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
  const escape = (v: unknown) => {
    if (v == null) return ""
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [
    columns.join(","),
    ...rows.map((r) => columns.map((c) => escape(r[c])).join(",")),
  ].join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  Object.assign(document.createElement("a"), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}
