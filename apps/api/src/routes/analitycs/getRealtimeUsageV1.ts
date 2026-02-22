import { createRoute } from "@hono/zod-openapi"
import { endTime, startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"

import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { bufferMetricsResponseSchema } from "~/usagelimiter/interface"
import { reportUsageEvents } from "~/util/reportUsageEvents"

const tags = ["analytics"]

export const route = createRoute({
  path: "/v1/analytics/realtime",
  operationId: "analytics.getRealtimeUsage",
  summary: "get real-time usage metrics",
  description:
    "Get real-time usage metrics from the Durable Object buffer. Returns unflushed usage and verification records (typically seconds to minutes old). Use this to avoid Tinybird query limits for real-time dashboards.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customer_id: z.string().openapi({
          description: "The customer ID to get real-time metrics for",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        project_id: z.string().openapi({
          description: "The project ID (optional, only available for main projects)",
          example: "project_1H7KQFLr7RepUyQBKdnvY",
        }),
        window_seconds: z
          .union([z.literal(300), z.literal(3600), z.literal(86400), z.literal(604800)])
          .optional()
          .openapi({
            description: "Time history window in seconds (5m, 60m, 1d, 7d)",
            example: 3600,
          }),
      }),
      "Body of the request for real-time usage metrics"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        metrics: bufferMetricsResponseSchema,
        source: z.literal("durable_object").openapi({
          description: "Indicates data comes from unflushed DO buffer, not Tinybird",
        }),
      }),
      "Real-time usage metrics from the Durable Object buffer"
    ),
    ...openApiErrorResponses,
  },
})

export type GetRealtimeUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetRealtimeUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetRealtimeUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      customer_id: customerId,
      project_id: projectId,
      window_seconds: windowSeconds,
    } = c.req.valid("json")
    const { usagelimiter } = c.get("services")

    const key = await keyAuth(c)

    startTime(c, "getRealtimeUsage")

    const isMain = key.project.workspace.isMain
    const projectID = isMain ? (projectId ? projectId : key.projectId) : key.projectId

    if (!isMain && projectID !== projectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to access this app analytics.",
      })
    }

    const { err, val: metrics } = await usagelimiter.getBufferMetrics({
      customerId,
      projectId: projectID,
      windowSeconds,
    })

    endTime(c, "getRealtimeUsage")

    if (err) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    c.executionCtx.waitUntil(reportUsageEvents(c, {}, "get-realtime-usage"))

    return c.json(
      {
        metrics,
        source: "durable_object" as const,
      },
      HttpStatusCodes.OK
    )
  })
