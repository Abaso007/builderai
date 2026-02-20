import { env } from "cloudflare:workers"
import { lakehouseSourceSchemaRegistry } from "@unprice/lakehouse"
import { UnpriceApiError } from "~/errors"
import { IcebergPathResolver } from "~/lakehouse/catalog"

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
const LAKEHOUSE_DEFAULT_NAMESPACE = "lakehouse"
const LAKEHOUSE_DEFAULT_PREFIX = "__r2_data_catalog"
const LAKEHOUSE_CREDENTIAL_CACHE_MAX_ENTRIES = 256
const LAKEHOUSE_CREDENTIAL_CACHE_MIN_BUFFER_MS = 15_000
const LAKEHOUSE_CREDENTIAL_CACHE_MAX_BUFFER_MS = 5 * 60 * 1000

type R2TempCredentialsResponse = {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
}

export interface IssueLakehouseCatalogCredentialsInput {
  projectId: string
  customerId?: string
  eventDate?: string
  durationSeconds: number
}

export interface IssueLakehouseCatalogCredentialsResult {
  bucket: string
  prefix: string
  prefixes: string[]
  tablePrefixes: Record<string, string>
  tableUrls: Record<string, string>
  durationSeconds: number
  r2Endpoint: string
  catalogUrl: string
  catalogWarehouse: string
  credentials: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
    expiration: number
  }
}

interface LakehouseCredentialCacheEntry {
  value: IssueLakehouseCatalogCredentialsResult
  validUntilMs: number
}

const lakehouseCredentialCache = new Map<string, LakehouseCredentialCacheEntry>()
const lakehouseCredentialInflight = new Map<
  string,
  Promise<IssueLakehouseCatalogCredentialsResult>
>()

function buildCatalogRootPrefixes(basePrefix: string): {
  tablePrefixes: Record<string, string>
  prefixes: string[]
} {
  const normalized = normalizePrefix(basePrefix)
  const rootPrefix = normalized ? `${normalized}/` : ""
  if (!rootPrefix) {
    return {
      tablePrefixes: {},
      prefixes: [],
    }
  }

  return {
    tablePrefixes: {},
    prefixes: [rootPrefix],
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "")
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

function toR2Key(bucketName: string, location: string): string {
  const s3Prefix = `s3://${bucketName}/`
  if (location.startsWith(s3Prefix)) {
    return location.slice(s3Prefix.length)
  }
  if (location.startsWith(`${bucketName}/`)) {
    return location.slice(bucketName.length + 1)
  }
  return location
}

function cloneCredentialResult(
  value: IssueLakehouseCatalogCredentialsResult
): IssueLakehouseCatalogCredentialsResult {
  return {
    ...value,
    prefixes: [...value.prefixes],
    tablePrefixes: { ...value.tablePrefixes },
    tableUrls: { ...value.tableUrls },
    credentials: { ...value.credentials },
  }
}

function cacheKeyPart(value: string | undefined): string {
  if (!value) return "*"
  return value
}

function buildCredentialCacheKey(params: {
  accountId: string
  bucketName: string
  parentAccessKeyId: string
  projectId: string
  customerId?: string
  eventDate?: string
  durationSeconds: number
  catalogUrl?: string
  catalogName?: string
  catalogNamespace: string
  fallbackPrefix: string
}): string {
  return [
    params.accountId,
    params.bucketName,
    params.parentAccessKeyId,
    params.projectId,
    cacheKeyPart(params.customerId),
    cacheKeyPart(params.eventDate),
    String(params.durationSeconds),
    cacheKeyPart(params.catalogUrl),
    cacheKeyPart(params.catalogName),
    params.catalogNamespace,
    params.fallbackPrefix,
  ].join("|")
}

function getCacheValidUntilMs(value: IssueLakehouseCatalogCredentialsResult): number {
  const now = Date.now()
  const durationMs = Math.max(0, value.durationSeconds * 1000)
  const expiryMs = Number(value.credentials.expiration)
  const safeExpiryMs = Number.isFinite(expiryMs) ? expiryMs : now + durationMs
  const bufferMs = Math.min(
    LAKEHOUSE_CREDENTIAL_CACHE_MAX_BUFFER_MS,
    Math.max(LAKEHOUSE_CREDENTIAL_CACHE_MIN_BUFFER_MS, Math.floor(durationMs * 0.1))
  )

  return safeExpiryMs - bufferMs
}

function getCachedLakehouseCredential(
  key: string
): IssueLakehouseCatalogCredentialsResult | undefined {
  const entry = lakehouseCredentialCache.get(key)
  if (!entry) return undefined

  if (entry.validUntilMs <= Date.now()) {
    lakehouseCredentialCache.delete(key)
    return undefined
  }

  lakehouseCredentialCache.delete(key)
  lakehouseCredentialCache.set(key, entry)
  return cloneCredentialResult(entry.value)
}

function setCachedLakehouseCredential(
  key: string,
  value: IssueLakehouseCatalogCredentialsResult
): void {
  const validUntilMs = getCacheValidUntilMs(value)
  if (validUntilMs <= Date.now()) {
    return
  }

  if (!lakehouseCredentialCache.has(key)) {
    while (lakehouseCredentialCache.size >= LAKEHOUSE_CREDENTIAL_CACHE_MAX_ENTRIES) {
      const oldestKey = lakehouseCredentialCache.keys().next().value
      if (!oldestKey) break
      lakehouseCredentialCache.delete(oldestKey)
    }
  }

  lakehouseCredentialCache.set(key, {
    value: cloneCredentialResult(value),
    validUntilMs,
  })
}

async function fetchR2TempCredentials(params: {
  accountId: string
  apiToken: string
  bucket: string
  parentAccessKeyId: string
  permission: "object-read-write" | "object-read-only"
  ttlSeconds: number
  prefixes?: string[]
}): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const url = `${CLOUDFLARE_API_BASE}/accounts/${params.accountId}/r2/temp-access-credentials`
  const body: {
    bucket: string
    parentAccessKeyId: string
    permission: string
    ttlSeconds: number
    prefixes?: string[]
  } = {
    bucket: params.bucket,
    parentAccessKeyId: params.parentAccessKeyId,
    permission: params.permission,
    ttlSeconds: params.ttlSeconds,
  }

  if (params.prefixes?.length) {
    body.prefixes = params.prefixes
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 403 && text.includes('"code":10000')) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Cloudflare authentication failed for R2 temp credentials. Check LAKEHOUSE_CREDENTIAL_TOKEN has access to CLOUDFLARE_ACCOUNT_ID.",
      })
    }

    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: `R2 temp credentials failed: ${res.status} ${text}`,
    })
  }

  const data = (await res.json()) as {
    result?: R2TempCredentialsResponse
    success?: boolean
    errors?: unknown[]
  }

  if (!data.success || !data.result) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: "R2 temp credentials API returned no result",
    })
  }

  const result = data.result
  if (!result.accessKeyId || !result.secretAccessKey || !result.sessionToken) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: "R2 temp credentials response missing fields",
    })
  }

  return {
    accessKeyId: result.accessKeyId,
    secretAccessKey: result.secretAccessKey,
    sessionToken: result.sessionToken,
  }
}

export function parseScopedId(value: string | undefined, fieldName: string): string | undefined {
  if (!value) {
    return undefined
  }

  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(value)) {
    throw new UnpriceApiError({
      code: "BAD_REQUEST",
      message: `${fieldName} format is invalid`,
    })
  }

  return value
}

export function resolveScopedProjectId(params: {
  callerProjectId: string
  requestedProjectId?: string
  isMainWorkspace: boolean
}): string {
  if (
    !params.isMainWorkspace &&
    params.requestedProjectId &&
    params.requestedProjectId !== params.callerProjectId
  ) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: "You are not allowed to access this project credentials",
    })
  }

  if (params.isMainWorkspace) {
    return params.requestedProjectId ?? params.callerProjectId
  }

  return params.callerProjectId
}

export function buildScopedPrefix(params: {
  basePrefix: string
  projectId: string
  customerId?: string
  eventDate?: string
}): string {
  const parts = [normalizePrefix(params.basePrefix), ""]

  if (params.projectId) {
    parts.push(`project_id=${params.projectId}`)
  }
  if (params.customerId) {
    parts.push(`customer_id=${params.customerId}`)
  }
  if (params.eventDate) {
    parts.push(`event_date=${params.eventDate}`)
  }

  return `${parts.filter((value) => value.length > 0).join("/")}/`
}

export async function issueLakehouseCatalogCredentials(
  params: IssueLakehouseCatalogCredentialsInput
): Promise<IssueLakehouseCatalogCredentialsResult> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = env.CLOUDFLARE_API_TOKEN_LAKEHOUSE
  const bucketName = env.LAKEHOUSE_BUCKET_NAME!
  const parentAccessKeyId = env.CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID
  const icebergPrefix = env.LAKEHOUSE_ICEBERG_PREFIX!

  const namespace = LAKEHOUSE_DEFAULT_NAMESPACE
  const fallbackPrefix = normalizePrefix(icebergPrefix || LAKEHOUSE_DEFAULT_PREFIX)
  const catalogName = bucketName
  const catalogUrl = `https://catalog.cloudflarestorage.com/${accountId}/${catalogName}`
  const catalogWarehouse = `${accountId}_${bucketName}`

  const cacheKey = buildCredentialCacheKey({
    accountId,
    bucketName,
    parentAccessKeyId,
    projectId: params.projectId,
    customerId: params.customerId,
    eventDate: params.eventDate,
    durationSeconds: params.durationSeconds,
    catalogUrl: catalogUrl,
    catalogName: catalogName,
    catalogNamespace: namespace,
    fallbackPrefix,
  })

  const cached = getCachedLakehouseCredential(cacheKey)
  if (cached) {
    return cached
  }

  const inflight = lakehouseCredentialInflight.get(cacheKey)
  if (inflight) {
    return cloneCredentialResult(await inflight)
  }

  const generatedPromise = (async (): Promise<IssueLakehouseCatalogCredentialsResult> => {
    const tables = Array.from(
      new Set(Object.values(lakehouseSourceSchemaRegistry).map((entry) => entry.sinkTable))
    )
    const resolver = new IcebergPathResolver({
      accountId,
      bucketName,
      warehouseId: catalogWarehouse,
      token: "lakehouse-stream-auth-token",
    })
    const partitionSpec: Record<string, string> = {
      project_id: params.projectId,
    }
    if (params.customerId) partitionSpec.customer_id = params.customerId
    if (params.eventDate) partitionSpec.event_date = params.eventDate

    const tableResults = await Promise.allSettled(
      tables.map(async (tableName) => {
        const result = await resolver.getPartitionPath(namespace, tableName, partitionSpec)
        const metadataPrefix = ensureTrailingSlash(
          toR2Key(bucketName, `${result.tableLocation}/metadata/`)
        )
        return {
          tableName,
          dataPrefix: ensureTrailingSlash(result.r2Key),
          metadataPrefix,
          tableUrl: result.partitionUrl,
        }
      })
    )

    const tablePrefixes: Record<string, string> = {}
    const tableUrls: Record<string, string> = {}
    const prefixSet = new Set<string>()

    let resolvedCount = 0
    tableResults.forEach((result, index) => {
      const tableName = tables[index] ?? "unknown"
      if (result.status === "fulfilled") {
        resolvedCount += 1
        tablePrefixes[result.value.tableName] = result.value.dataPrefix
        tableUrls[result.value.tableName] = result.value.tableUrl
        prefixSet.add(result.value.dataPrefix)
        prefixSet.add(result.value.metadataPrefix)
      } else {
        console.warn("[lakehouse][catalog] failed to resolve table partition", {
          tableName,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    })

    let prefixes = Array.from(prefixSet)
    if (resolvedCount === 0) {
      // TODO: fix this - use duckdb to list and signed urls for all tables in the bucket
      const fallback = buildCatalogRootPrefixes(fallbackPrefix)
      prefixes = fallback.prefixes
    }

    if (prefixes.length === 0) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Lakehouse catalog lookup returned no prefixes to scope credentials.",
      })
    }

    const credentials = await fetchR2TempCredentials({
      accountId,
      apiToken,
      bucket: bucketName,
      parentAccessKeyId,
      permission: "object-read-only",
      ttlSeconds: params.durationSeconds,
      prefixes,
    })

    const result: IssueLakehouseCatalogCredentialsResult = {
      bucket: bucketName,
      prefix: "",
      prefixes,
      tablePrefixes,
      tableUrls,
      durationSeconds: params.durationSeconds,
      r2Endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      catalogUrl,
      catalogWarehouse,
      credentials: {
        ...credentials,
        expiration: Date.now() + params.durationSeconds * 1000,
      },
    }

    setCachedLakehouseCredential(cacheKey, result)
    return result
  })()

  lakehouseCredentialInflight.set(cacheKey, generatedPromise)

  try {
    return cloneCredentialResult(await generatedPromise)
  } finally {
    lakehouseCredentialInflight.delete(cacheKey)
  }
}
