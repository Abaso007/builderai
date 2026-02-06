import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"

import { z } from "zod"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["lakehouse"]

import type { z as zodZodOpenApi } from "@hono/zod-openapi"

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function streamContent(schema: zodZodOpenApi.ZodType<any>, description: string) {
  return {
    content: {
      // Use specific type for NDJSON or generic "application/octet-stream"
      "application/x-ndjson": {
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
  tags,
  request: {
    query: z.object({
      key: z.string().openapi({
        description: "The key of the file to get",
        example: "customer_123/2021/01/01/flush=123.ndjson",
      }),
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
  // @ts-expect-error - stream/binary response: returning raw Response is correct; zod-openapi's RouteConfigToTypedResponse doesn't include Response
  app.openapi(route, async (c) => {
    const { key } = c.req.valid("query")

    console.log("headers", c.req.raw.headers)

    // Check If-None-Match for 304
    const ifNoneMatch = c.req.header("If-None-Match")

    // Get object from R2
    const obj = await c.env.LAKEHOUSE?.get(key)

    if (!obj) {
      return c.json({ error: "File not found" }, 404)
    }

    // Check for 304 Not Modified
    if (ifNoneMatch && obj.etag && ifNoneMatch === `"${obj.etag}"`) {
      return new Response(null, { status: 304 })
    }

    // Stream the file (return raw Response so type matches OpenAPI stream/binary and body is not JSON-serialized)
    const headers = new Headers()
    headers.set("Content-Type", "application/x-ndjson")
    headers.set("Content-Length", obj.size.toString())
    headers.set("ETag", `"${obj.etag}"`)
    headers.set("Cache-Control", "public, max-age=31536000, immutable")

    return new Response(obj.body, { status: HttpStatusCodes.OK, headers })
  })
