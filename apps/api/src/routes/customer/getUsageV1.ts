import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent } from "stoker/openapi/helpers"

import { currentUsageSchema } from "@unprice/db/validators"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/{customerId}/getUsage",
  operationId: "customers.getUsage",
  summary: "get usage",
  description: "Get usage for a customer",
  method: "get",
  tags,
  request: {
    params: z.object({
      customerId: z.string().openapi({
        description: "The customer ID",
        example: "cus_1H7KQFLr7RepUyQBKdnvY",
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      currentUsageSchema.openapi({
        description: "The current usage data for the customer",
      }),
      "The result of the get usage"
    ),
    ...openApiErrorResponses,
  },
})

export type GetUsageRequest = z.infer<typeof route.request.params>
export type GetUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId } = c.req.valid("param")
    const { usagelimiter } = c.get("services")
    const now = Date.now()

    // validate the request
    const key = await keyAuth(c)

    const { err, val: result } = await usagelimiter.getCurrentUsage({
      customerId,
      projectId: key.projectId,
      now,
    })

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
