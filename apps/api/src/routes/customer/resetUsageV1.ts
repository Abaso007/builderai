import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { endTime } from "hono/timing"
import { startTime } from "hono/timing"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors/http"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/resetUsage",
  operationId: "customers.resetUsage",
  summary: "reset usage",
  description: "Reset usage counters for a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        projectId: z.string().openapi({
          description: "The project ID",
          example: "proj_1H7KQFLr7RepUyQBKdnvY",
        }),
      }),
      "The customer ID"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        success: z.boolean(),
      }),
      "The result of the reset usage"
    ),
    ...openApiErrorResponses,
  },
})

export type ResetUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ResetUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerResetUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")
    const { usagelimiter } = c.get("services")

    await keyAuth(c)

    const isMain = c.get("isMain")
    if (!isMain) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "Only main keys can reset usage.",
      })
    }

    startTime(c, "resetUsage")

    const { err } = await usagelimiter.resetUsage({
      customerId,
      projectId,
    })

    endTime(c, "resetUsage")

    if (err) {
      throw err
    }

    return c.json({ success: true }, HttpStatusCodes.OK)
  })
