import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import {
  issueLakehouseCatalogCredentials,
  parseScopedId,
  resolveScopedProjectId,
} from "~/lakehouse/catalog-credentials"

const tags = ["lakehouse"]

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

    const scopedProjectId = resolveScopedProjectId({
      callerProjectId,
      requestedProjectId,
      isMainWorkspace: key.project.workspace.isMain,
    })
    const scopedCustomerId = parseScopedId(body.customerId, "customerId")

    const durationSeconds = body.durationSeconds ?? 60
    const credentials = await issueLakehouseCatalogCredentials({
      env: c.env,
      workspaceId,
      projectId: scopedProjectId,
      customerId: scopedCustomerId,
      durationSeconds,
    })

    return c.json(credentials, HttpStatusCodes.OK)
  })
