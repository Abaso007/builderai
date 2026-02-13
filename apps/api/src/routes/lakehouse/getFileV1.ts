import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { verifyLakehouseSignature } from "~/util/lakehouse"

const tags = ["lakehouse"]

import { env } from "cloudflare:workers"
import type { z as zodZodOpenApi } from "@hono/zod-openapi"

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function streamContent(schema: zodZodOpenApi.ZodType<any>, description: string) {
  return {
    content: {
      // Generic binary stream (NDJSON or Parquet)
      "application/octet-stream": {
        schema,
      },
    },
    description,
  }
}

export const route = createRoute({
  path: "/v1/lakehouse/file",
  operationId: "lakehouse.getFile",
  summary: "get lakehouse file",
  description: "Get lakehouse file for a given key",
  method: "get",
  hide: env.NODE_ENV === "production",
  tags,
  request: {
    query: z.object({
      key: z.string().openapi({
        description: "The key of the file to get",
        example: "customer_123/2021/01/01/flush=123.ndjson",
      }),
      exp: z.coerce
        .number()
        .int()
        .optional()
        .openapi({ description: "Signed URL expiry (epoch seconds)" }),
      sig: z.string().optional().openapi({ description: "Signed URL signature" }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: streamContent(
      // This tells OpenAPI clients: "This is a binary file stream"
      z
        .string()
        .openapi({ format: "binary" }),
      "Stream of the file"
    ),
    ...openApiErrorResponses,
  },
})

// Handler returns raw Response for stream; @hono/zod-openapi types don't support binary/stream responses
export const registerGetLakehouseFileV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, exp, sig } = c.req.valid("query")

    const authHeader = c.req.header("authorization")
    if (authHeader) {
      // Validate request and scope to project
      const apiKey = await keyAuth(c)
      const projectPrefix = `lakehouse/${apiKey.projectId}/`
      if (!key.startsWith(projectPrefix)) {
        return c.json({ error: "Forbidden" }, 403)
      }
    } else {
      if (!exp || !sig) {
        return c.json({ error: "Unauthorized" }, HttpStatusCodes.UNAUTHORIZED)
      }
      const now = Math.floor(Date.now() / 1000)
      if (exp < now) {
        return c.json({ error: "Expired" }, HttpStatusCodes.UNAUTHORIZED)
      }
      const ok = await verifyLakehouseSignature({
        secret: c.env.AUTH_SECRET,
        key,
        exp,
        sig,
      })
      if (!ok) {
        return c.json({ error: "Unauthorized" }, HttpStatusCodes.UNAUTHORIZED)
      }
    }

    // Check If-None-Match for 304
    const ifNoneMatch = c.req.header("If-None-Match")

    // Get object from R2
    const obj = await c.env.LAKEHOUSE?.get(key)

    if (!obj) {
      return c.json({ error: "File not found" }, 404)
    }

    const isCompactedKey = key.includes("/compacted/")
    const cacheControl = authHeader
      ? "private, max-age=0, must-revalidate"
      : isCompactedKey
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600, immutable"
    const quotedEtag = obj.etag ? `"${obj.etag}"` : undefined

    // Check for 304 Not Modified
    if (ifNoneMatch && quotedEtag) {
      const requestEtags = ifNoneMatch.split(",").map((value) => value.trim())
      const isNotModified = requestEtags.includes("*") || requestEtags.includes(quotedEtag)
      if (isNotModified) {
        const headers = new Headers()
        headers.set("ETag", quotedEtag)
        headers.set("Cache-Control", cacheControl)
        headers.set("Vary", "Authorization")
        return new Response(null, { status: 304, headers })
      }
    }

    // Stream the file (return raw Response so type matches OpenAPI stream/binary and body is not JSON-serialized)
    const headers = new Headers()
    const isParquet = key.endsWith(".parquet")
    headers.set(
      "Content-Type",
      isParquet ? "application/vnd.apache.parquet" : "application/x-ndjson"
    )
    headers.set("Content-Length", obj.size.toString())
    if (quotedEtag) {
      headers.set("ETag", quotedEtag)
    }
    headers.set("Cache-Control", cacheControl)
    headers.set("Vary", "Authorization")

    return new Response(obj.body, { status: HttpStatusCodes.OK, headers })
  })
