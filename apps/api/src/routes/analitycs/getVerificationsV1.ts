import { createRoute } from "@hono/zod-openapi"
import {
  analyticsIntervalSchema,
  getAnalyticsVerificationsResponseSchema,
  prepareInterval,
} from "@unprice/analytics"
import { endTime, startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { reportUsageEvents } from "~/util/reportUsageEvents"

const tags = ["analytics"]

export const route = createRoute({
  path: "/v1/analytics/verifications",
  operationId: "analytics.getVerifications",
  summary: "get verifications",
  description: "Get verifications for a customer in a given range",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().optional().openapi({
          description:
            "The customer ID if you want to get the verifications for a specific customer",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        projectId: z.string().openapi({
          description:
            "The project ID (optional, if not provided, the project ID will be the one of the key)",
          example: "project_1H7KQFLr7RepUyQBKdnvY",
        }),
        range: analyticsIntervalSchema.openapi({
          description: "The range of the verifications, last hour, day, week or month",
          example: "24h",
        }),
      }),
      "Body of the request for the get verifications"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        verifications: getAnalyticsVerificationsResponseSchema.array(),
      }),
      "The result of the get verifications"
    ),
    ...openApiErrorResponses,
  },
})

export type GetAnalyticsVerificationsRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type GetAnalyticsVerificationsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetAnalyticsVerificationsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, range, projectId } = c.req.valid("json")
    const { analytics, cache } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getVerifications")

    const { intervalDays } = prepareInterval(range)

    // main workspace can see all verifications
    const isMain = key.project.workspace.isMain
    const projectID = isMain ? (projectId ? projectId : key.projectId) : key.projectId

    if (!isMain && projectID !== projectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to access this app analytics.",
      })
    }

    const cacheKey = `${projectID}:${customerId}:${intervalDays}`

    const { err, val: data } = await cache.getVerifications.swr(cacheKey, async () => {
      const result = analytics
        .getFeaturesVerifications({
          projectId,
          intervalDays,
          customerId,
        })
        .then((res) => res.data)

      return result
    })

    // throw error if there is an error
    if (err) {
      throw err
    }

    // end the timer
    endTime(c, "getVerifications")

    // send analytics event for the unprice customer
    c.executionCtx.waitUntil(
      reportUsageEvents(c, { action: "getVerifications", status: err ? "error" : "success" })
    )

    return c.json(
      {
        verifications: data ?? [],
      },
      HttpStatusCodes.OK
    )
  })
