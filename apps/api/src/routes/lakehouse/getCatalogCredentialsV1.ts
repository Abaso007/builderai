import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { createTicket } from "~/auth/ticket"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import {
  issueLakehouseCatalogCredentials,
  parseScopedId,
  resolveScopedProjectId,
} from "~/lakehouse/service"

const tags = ["lakehouse"]

const responseSchema = z.object({
  bucket: z.string(),
  prefix: z.string(),
  prefixes: z.array(z.string()),
  tablePrefixes: z.record(z.string()),
  tableUrls: z.record(z.string()),
  durationSeconds: z.number().int(),
  r2Endpoint: z.string().url(),
  catalogUrl: z.string().url(),
  catalogWarehouse: z.string(),
  ticket: z.string(),
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
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
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
    const callerProjectId = c.get("projectId")

    if (!callerProjectId) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "project id is required",
      })
    }

    const scopedProjectId = resolveScopedProjectId({
      callerProjectId,
      requestedProjectId,
      isMainWorkspace: key.project.workspace.isMain,
    })
    const scopedCustomerId = parseScopedId(body.customerId, "customerId")

    const durationSeconds = body.durationSeconds ?? 3600 // 1 hour
    const credentials = await issueLakehouseCatalogCredentials({
      projectId: scopedProjectId,
      customerId: scopedCustomerId,
      eventDate: body.date,
      durationSeconds,
    })

    const requestUrl = new URL(c.req.url)
    const accountId = c.env.CLOUDFLARE_ACCOUNT_ID
    const ticket = await createTicket({
      secret: c.env.AUTH_SECRET,
      projectId: scopedProjectId,
      accountId,
      bucket: credentials.bucket,
      customerId: scopedCustomerId,
      eventDate: body.date,
      expiresInSeconds: durationSeconds,
    })
    const catalogUrl = `${requestUrl.origin}/v1/lakehouse/catalog/proxy/${ticket}`

    return c.json(
      {
        ...credentials,
        catalogUrl,
        ticket,
      },
      HttpStatusCodes.OK
    )
  })
