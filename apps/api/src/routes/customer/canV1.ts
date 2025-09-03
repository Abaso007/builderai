import { createRoute } from "@hono/zod-openapi"
import { endTime } from "hono/timing"
import { startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { canResponseSchema } from "~/entitlement/interface"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { reportUsage } from "~/util/reportUsage"
const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/can",
  operationId: "customer.can",
  summary: "can feature",
  description: "Check if a customer can use a feature",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        featureSlug: z.string().openapi({
          description: "The feature slug",
          example: "tokens",
        }),
        async: z.boolean().optional().openapi({
          description:
            "if true will check the entitlement from cache and revalidate asyncronously. This will reduce latency for the request but won't have 100% accuracy. If false, the entitlement will be validated synchronously 100% accurate but will have a higher latency",
          example: true,
          default: false,
        }),
        // timestamp: z.number().optional().openapi({
        //   description: "The timestamp of the request",
        //   example: 1717852800,
        // }),
        metadata: z
          .record(z.string(), z.string())
          .openapi({
            description: "The metadata",
            example: {
              action: "create",
              country: "US",
            },
          })
          .optional(),
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(canResponseSchema, "The result of the can check"),
    ...openApiErrorResponses,
  },
})

export type CanRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type CanResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerCanV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, featureSlug, metadata, async } = c.req.valid("json")
    const { entitlement } = c.get("services")
    const stats = c.get("stats")
    const requestId = c.get("requestId")
    const performanceStart = c.get("performanceStart")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, `can${async ? "Async" : "Sync"}`)

    // validate usage from db
    const result = await entitlement.can({
      customerId,
      featureSlug,
      projectId: key.projectId,
      requestId,
      performanceStart,
      async,
      // short ttl for dev
      flushTime: c.env.NODE_ENV === "development" ? 5 : undefined,
      timestamp: Date.now(), // for now we report the usage at the time of the request
      metadata: {
        ...metadata,
        ip: stats.ip,
        country: stats.country,
        region: stats.region,
        colo: stats.colo,
        city: stats.city,
        latitude: stats.latitude,
        longitude: stats.longitude,
        ua: stats.ua,
        continent: stats.continent,
        source: stats.source,
      },
    })

    // send analytics event for the unprice customer
    c.executionCtx.waitUntil(reportUsage(c, { action: "can" }))

    // end the timer
    endTime(c, `can${async ? "Async" : "Sync"}`)

    return c.json(result, HttpStatusCodes.OK)
  })
