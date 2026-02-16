import type { Logger } from "@unprice/logging"
import { UnpriceApiError } from "~/errors"
import {
  CloudflarePipelineLakehouseService,
  type LakehousePipelineBindingsBySource,
} from "./pipeline"

interface LakehouseServiceEnv {
  APP_ENV?: "development" | "preview" | "production"
  CLOUDFLARE_API_TOKEN?: string
  LAKEHOUSE_PIPELINE_USAGE?: { send: (records: unknown[]) => Promise<void> }
  LAKEHOUSE_PIPELINE_VERIFICATION?: { send: (records: unknown[]) => Promise<void> }
  LAKEHOUSE_PIPELINE_METADATA?: { send: (records: unknown[]) => Promise<void> }
  LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT?: { send: (records: unknown[]) => Promise<void> }
  LAKEHOUSE_STREAM_USAGE_URL?: string
  LAKEHOUSE_STREAM_VERIFICATIONS_URL?: string
  LAKEHOUSE_STREAM_METADATA_URL?: string
  LAKEHOUSE_STREAM_ENTITLEMENTS_URL?: string
  LAKEHOUSE_STREAM_AUTH_TOKEN?: string
}

class HttpLakehousePipelineSender {
  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  async send(records: unknown[]): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(records),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(
        `Lakehouse stream ingest failed (${res.status}): ${body.slice(0, 1000) || "no response body"}`
      )
    }
  }
}

function createBindingSenders(env: LakehouseServiceEnv): LakehousePipelineBindingsBySource {
  if (
    !env.LAKEHOUSE_PIPELINE_USAGE ||
    !env.LAKEHOUSE_PIPELINE_VERIFICATION ||
    !env.LAKEHOUSE_PIPELINE_METADATA ||
    !env.LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT
  ) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Lakehouse pipeline bindings are required outside development (LAKEHOUSE_PIPELINE_USAGE, LAKEHOUSE_PIPELINE_VERIFICATION, LAKEHOUSE_PIPELINE_METADATA, LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT).",
    })
  }

  return {
    usage: env.LAKEHOUSE_PIPELINE_USAGE,
    verification: env.LAKEHOUSE_PIPELINE_VERIFICATION,
    metadata: env.LAKEHOUSE_PIPELINE_METADATA,
    entitlement_snapshot: env.LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT,
  }
}

function hasBindingSenders(env: LakehouseServiceEnv): boolean {
  return Boolean(
    env.LAKEHOUSE_PIPELINE_USAGE &&
      env.LAKEHOUSE_PIPELINE_VERIFICATION &&
      env.LAKEHOUSE_PIPELINE_METADATA &&
      env.LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT
  )
}

function hasHttpStreamConfig(env: LakehouseServiceEnv): boolean {
  const token = env.LAKEHOUSE_STREAM_AUTH_TOKEN ?? env.CLOUDFLARE_API_TOKEN
  return Boolean(
    token &&
      env.LAKEHOUSE_STREAM_USAGE_URL &&
      env.LAKEHOUSE_STREAM_VERIFICATIONS_URL &&
      env.LAKEHOUSE_STREAM_METADATA_URL &&
      env.LAKEHOUSE_STREAM_ENTITLEMENTS_URL
  )
}

function createHttpStreamSenders(env: LakehouseServiceEnv): LakehousePipelineBindingsBySource {
  const token = env.LAKEHOUSE_STREAM_AUTH_TOKEN ?? env.CLOUDFLARE_API_TOKEN
  if (!token) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Lakehouse development HTTP ingest requires LAKEHOUSE_STREAM_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN).",
    })
  }

  const missing: string[] = []
  if (!env.LAKEHOUSE_STREAM_USAGE_URL) missing.push("LAKEHOUSE_STREAM_USAGE_URL")
  if (!env.LAKEHOUSE_STREAM_VERIFICATIONS_URL) missing.push("LAKEHOUSE_STREAM_VERIFICATIONS_URL")
  if (!env.LAKEHOUSE_STREAM_METADATA_URL) missing.push("LAKEHOUSE_STREAM_METADATA_URL")
  if (!env.LAKEHOUSE_STREAM_ENTITLEMENTS_URL) missing.push("LAKEHOUSE_STREAM_ENTITLEMENTS_URL")

  if (missing.length > 0) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Lakehouse development HTTP ingest is missing stream URLs: ${missing.join(", ")}`,
    })
  }

  const usageUrl = env.LAKEHOUSE_STREAM_USAGE_URL
  const verificationUrl = env.LAKEHOUSE_STREAM_VERIFICATIONS_URL
  const metadataUrl = env.LAKEHOUSE_STREAM_METADATA_URL
  const entitlementUrl = env.LAKEHOUSE_STREAM_ENTITLEMENTS_URL

  if (!usageUrl || !verificationUrl || !metadataUrl || !entitlementUrl) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Lakehouse development HTTP ingest stream URLs are invalid.",
    })
  }

  return {
    usage: new HttpLakehousePipelineSender(usageUrl, token),
    verification: new HttpLakehousePipelineSender(verificationUrl, token),
    metadata: new HttpLakehousePipelineSender(metadataUrl, token),
    entitlement_snapshot: new HttpLakehousePipelineSender(entitlementUrl, token),
  }
}

export function createCloudflareLakehouseService(params: {
  logger: Logger
  env: LakehouseServiceEnv
}): CloudflarePipelineLakehouseService {
  let pipelines: LakehousePipelineBindingsBySource
  let mode: "http-stream" | "binding"

  if (params.env.APP_ENV === "development") {
    if (hasHttpStreamConfig(params.env)) {
      pipelines = createHttpStreamSenders(params.env)
      mode = "http-stream"
    } else if (hasBindingSenders(params.env)) {
      pipelines = createBindingSenders(params.env)
      mode = "binding"
      params.logger.warn(
        "Lakehouse dev HTTP stream config missing; falling back to pipeline bindings"
      )
    } else {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Lakehouse development mode requires HTTP stream config (LAKEHOUSE_STREAM_*_URL + LAKEHOUSE_STREAM_AUTH_TOKEN/CLOUDFLARE_API_TOKEN) or pipeline bindings.",
      })
    }
  } else {
    pipelines = createBindingSenders(params.env)
    mode = "binding"
  }

  params.logger.debug("Lakehouse sender mode selected", {
    mode,
    appEnv: params.env.APP_ENV ?? "unknown",
  })

  return new CloudflarePipelineLakehouseService({
    logger: params.logger,
    pipelines,
  })
}

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

type R2TempCredentialsResponse = {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
}

export interface LakehouseCatalogCredentialEnv {
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN_LAKEHOUSE?: string
  CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID?: string
  LAKEHOUSE_BUCKET_NAME?: string
  LAKEHOUSE_ICEBERG_PREFIX?: string
}

export interface IssueLakehouseCatalogCredentialsInput {
  env: LakehouseCatalogCredentialEnv
  projectId: string
  customerId?: string
  durationSeconds: number
}

export interface IssueLakehouseCatalogCredentialsResult {
  bucket: string
  prefix: string
  durationSeconds: number
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
        "Lakehouse credentials not configured (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN_LAKEHOUSE, CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID, LAKEHOUSE_BUCKET_NAME required)",
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
    if (res.status === 403 && text.includes('"code":10000')) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Cloudflare authentication failed for R2 temp credentials. Check CLOUDFLARE_API_TOKEN_LAKEHOUSE has access to CLOUDFLARE_ACCOUNT_ID.",
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
}): string {
  const parts = [params.basePrefix.replace(/^\/+|\/+$/g, ""), ""]

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
  const accountId = requireEnvVar(params.env.CLOUDFLARE_ACCOUNT_ID)
  const apiToken = requireEnvVar(params.env.CLOUDFLARE_API_TOKEN_LAKEHOUSE)
  const bucketName = requireEnvVar(params.env.LAKEHOUSE_BUCKET_NAME)
  const parentAccessKeyId = requireEnvVar(params.env.CLOUDFLARE_LAKEHOUSE_ACCESS_KEY_ID)

  const prefix = buildScopedPrefix({
    basePrefix: params.env.LAKEHOUSE_ICEBERG_PREFIX ?? "__r2_data_catalog",
    projectId: params.projectId,
    customerId: params.customerId,
  })

  // apiToken authenticates the Cloudflare REST call; parentAccessKeyId picks the base R2 key being scoped.
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
    r2Endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      ...credentials,
      expiration: Date.now() + params.durationSeconds * 1000,
    },
  }
}
