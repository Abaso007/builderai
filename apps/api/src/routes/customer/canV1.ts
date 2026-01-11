import { createRoute } from "@hono/zod-openapi"
import { endTime } from "hono/timing"
import { startTime } from "hono/timing"
import { verificationResultSchema } from "node_modules/@unprice/db/src/validators/entitlements"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { bouncer } from "~/util/bouncer"
import { reportUsageEvents } from "~/util/reportUsageEvents"
const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/can",
  operationId: "customers.can",
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
    [HttpStatusCodes.OK]: jsonContent(verificationResultSchema, "The result of the can check"),
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
    const { customerId, featureSlug, metadata } = c.req.valid("json")
    const { usagelimiter } = c.get("services")
    const stats = c.get("stats")
    const requestId = c.get("requestId")
    const performanceStart = c.get("performanceStart")

    // validate the request
    const key = await keyAuth(c)

    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    // check if the customer is blocked
    await bouncer(c, customerId, projectId)

    // start a new timer
    startTime(c, "can")

    // validate usage from db
    const { err, val: result } = await usagelimiter.verify({
      customerId,
      featureSlug,
      projectId,
      requestId,
      performanceStart,
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
        ua: stats.ua,
        continent: stats.continent,
        source: stats.source,
      },
    })

    // end the timer
    endTime(c, "can")

    // send analytics event for the unprice customer
    c.executionCtx.waitUntil(
      reportUsageEvents(c, { action: "can", status: err ? "error" : "success" })
    )

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
