import { UnpriceApiError } from "~/errors"

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

type R2TempCredentialsResponse = {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
}

export interface LakehouseCatalogCredentialEnv {
  CLOUDFLARE_ACCOUNT_ID_LAKEHOUSE?: string
  CLOUDFLARE_API_TOKEN_LAKEHOUSE?: string
  CLOUDFLARE_PARENT_ACCESS_KEY_ID_LAKEHOUSE?: string
  LAKEHOUSE_BUCKET_NAME?: string
  LAKEHOUSE_ICEBERG_PREFIX?: string
}

export interface IssueLakehouseCatalogCredentialsInput {
  env: LakehouseCatalogCredentialEnv
  workspaceId: string
  projectId: string
  customerId?: string
  durationSeconds: number
}

export interface IssueLakehouseCatalogCredentialsResult {
  bucket: string
  prefix: string
  durationSeconds: number
  workspaceId: string
  r2Endpoint: string
  credentials: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
    expiration: number
  }
}

function requireEnvVar(value: string | undefined): string {
  if (!value) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Lakehouse credentials not configured (CLOUDFLARE_ACCOUNT_ID_LAKEHOUSE, CLOUDFLARE_API_TOKEN_LAKEHOUSE, LAKEHOUSE_BUCKET_NAME, CLOUDFLARE_PARENT_ACCESS_KEY_ID_LAKEHOUSE required)",
    })
  }
  return value
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
  workspaceId: string
  projectId?: string
  customerId?: string
}): string {
  const parts = [params.basePrefix.replace(/^\/+|\/+$/g, ""), `workspace_id=${params.workspaceId}`]

  if (params.projectId) {
    parts.push(`project_id=${params.projectId}`)
  }
  if (params.customerId) {
    parts.push(`customer_id=${params.customerId}`)
  }

  return `${parts.filter((value) => value.length > 0).join("/")}/`
}

export async function issueLakehouseCatalogCredentials(
  params: IssueLakehouseCatalogCredentialsInput
): Promise<IssueLakehouseCatalogCredentialsResult> {
  const accountId = requireEnvVar(params.env.CLOUDFLARE_ACCOUNT_ID_LAKEHOUSE)
  const apiToken = requireEnvVar(params.env.CLOUDFLARE_API_TOKEN_LAKEHOUSE)
  const bucketName = requireEnvVar(params.env.LAKEHOUSE_BUCKET_NAME)
  const parentAccessKeyId = requireEnvVar(params.env.CLOUDFLARE_PARENT_ACCESS_KEY_ID_LAKEHOUSE)

  const prefix = buildScopedPrefix({
    basePrefix: params.env.LAKEHOUSE_ICEBERG_PREFIX ?? "lakehouse/iceberg",
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    customerId: params.customerId,
  })

  const credentials = await fetchR2TempCredentials({
    accountId,
    apiToken,
    bucket: bucketName,
    parentAccessKeyId,
    permission: "object-read-only",
    ttlSeconds: params.durationSeconds,
    prefixes: [prefix],
  })

  return {
    bucket: bucketName,
    prefix,
    durationSeconds: params.durationSeconds,
    workspaceId: params.workspaceId,
    r2Endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      ...credentials,
      expiration: Date.now() + params.durationSeconds * 1000,
    },
  }
}
