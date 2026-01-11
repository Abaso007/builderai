import { createRoute } from "@hono/zod-openapi"
import { reportUsageResultSchema } from "@unprice/db/validators"
import { endTime, startTime } from "hono/timing"
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
  path: "/v1/customer/reportUsage",
  operationId: "customers.reportUsage",
  summary: "report usage",
  description: "Report usage for a customer",
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
        // timestamp: z.number().optional().openapi({
        //   description: "The timestamp of the request",
        //   example: 1717852800,
        // }),
        usage: z.number().openapi({
          description: "The usage",
          example: 30,
        }),
        idempotenceKey: z.string().uuid().openapi({
          description: "The idempotence key",
          example: "123e4567-e89b-12d3-a456-426614174000",
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
      "The usage to report"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(reportUsageResultSchema, "The result of the report usage"),
    ...openApiErrorResponses,
  },
})

export type ReportUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ReportUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerReportUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, featureSlug, usage, idempotenceKey, metadata } = c.req.valid("json")
    const { usagelimiter } = c.get("services")
    const stats = c.get("stats")
    const requestId = c.get("requestId")

    // validate the request
    const key = await keyAuth(c)

    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    // check if the customer is blocked
    // ONLY bounce if usage is positive (consuming) because negative usage is a correction
    if (usage >= 0) {
      await bouncer(c, customerId, projectId)
    }

    // start a new timer
    startTime(c, "reportUsage")

    // validate usage from db
    const { err, val: result } = await usagelimiter.reportUsage({
      customerId,
      featureSlug,
      usage,
      // timestamp of the record
      timestamp: Date.now(), // for now we report the usage at the time of the request
      idempotenceKey,
      // short ttl for dev
      flushTime: c.env.NODE_ENV === "development" ? 5 : undefined,
      projectId,
      requestId,
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
    endTime(c, "reportUsage")

    // send analytics event for the unprice customer
    c.executionCtx.waitUntil(
      reportUsageEvents(c, { action: "reportUsage", status: err ? "error" : "success" })
    )

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
