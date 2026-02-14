import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["lakehouse"]

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

type R2TempCredentialsResponse = {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
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

  const r = data.result
  if (!r.accessKeyId || !r.secretAccessKey || !r.sessionToken) {
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: "R2 temp credentials response missing fields",
    })
  }

  return {
    accessKeyId: r.accessKeyId,
    secretAccessKey: r.secretAccessKey,
    sessionToken: r.sessionToken,
  }
}

const responseSchema = z.object({
  bucket: z.string(),
  prefix: z.string(),
  durationSeconds: z.number().int(),
  workspaceId: z.string(),
  r2Endpoint: z.string().url(),
  credentials: z.object({
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    sessionToken: z.string(),
    expiration: z.union([z.string(), z.number()]).optional(),
  }),
})

const requestSchema = z.object({
  durationSeconds: z.number().int().min(60).max(3600).default(60).optional(),
  projectId: z.string().optional(),
  customerId: z.string().optional(),
})

export const route = createRoute({
  path: "/v1/lakehouse/catalog/credentials",
  operationId: "lakehouse.getCatalogCredentials",
  summary: "get scoped lakehouse credentials",
  description:
    "Issue short-lived, workspace-scoped temporary R2 credentials for direct DuckDB-Iceberg access",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(requestSchema, "Scoped credential request payload"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(responseSchema, "Scoped temporary credentials"),
    ...openApiErrorResponses,
  },
})

function parseScopedId(value: string | undefined, fieldName: string): string | undefined {
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

function buildScopedPrefix(params: {
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

export type GetCatalogCredentialsRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type GetCatalogCredentialsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetCatalogCredentialsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const key = await keyAuth(c)
    const requestedProjectId = parseScopedId(body.projectId, "projectId")
    const workspaceId = c.get("workspaceId")
    const callerProjectId = c.get("projectId")

    if (!workspaceId) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "workspace id is required",
      })
    }

    if (!callerProjectId) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "project id is required",
      })
    }

    if (
      !key.project.workspace.isMain &&
      requestedProjectId &&
      requestedProjectId !== callerProjectId
    ) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to access this project credentials",
      })
    }

    const scopedProjectId = key.project.workspace.isMain
      ? (requestedProjectId ?? callerProjectId)
      : callerProjectId
    const scopedCustomerId = parseScopedId(body.customerId, "customerId")

    const prefix = buildScopedPrefix({
      basePrefix: c.env.LAKEHOUSE_ICEBERG_PREFIX ?? "lakehouse/iceberg",
      workspaceId,
      projectId: scopedProjectId,
      customerId: scopedCustomerId,
    })

    const accountId = c.env.CLOUDFLARE_ACCOUNT_ID_LAKEHOUSE
    const apiToken = c.env.CLOUDFLARE_API_TOKEN_LAKEHOUSE
    const bucketName = c.env.LAKEHOUSE_BUCKET_NAME
    const parentAccessKeyId = c.env.CLOUDFLARE_PARENT_ACCESS_KEY_ID_LAKEHOUSE

    if (!accountId || !apiToken || !bucketName || !parentAccessKeyId) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Lakehouse credentials not configured (CLOUDFLARE_ACCOUNT_ID_LAKEHOUSE, CLOUDFLARE_API_TOKEN_LAKEHOUSE, LAKEHOUSE_BUCKET_NAME, CLOUDFLARE_PARENT_ACCESS_KEY_ID_LAKEHOUSE required)",
      })
    }

    const durationSeconds = body.durationSeconds ?? 60
    const credentials = await fetchR2TempCredentials({
      accountId,
      apiToken,
      bucket: bucketName,
      parentAccessKeyId,
      permission: "object-read-write",
      ttlSeconds: durationSeconds,
      prefixes: [prefix],
    })

    const expirationMs = Date.now() + durationSeconds * 1000
    return c.json(
      {
        bucket: bucketName,
        prefix,
        durationSeconds,
        workspaceId,
        r2Endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          ...credentials,
          expiration: expirationMs,
        },
      },
      HttpStatusCodes.OK
    )
  })
