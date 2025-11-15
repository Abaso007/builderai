import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent } from "stoker/openapi/helpers"

import { getCurrentUsageSchema } from "@unprice/db/validators"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/{customerId}/getUsage",
  operationId: "customer.getUsage",
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
    [HttpStatusCodes.OK]: jsonContent(getCurrentUsageSchema, "The result of the get usage"),
    ...openApiErrorResponses,
  },
})

export type GetSubscriptionRequest = z.infer<typeof route.request.params>
export type GetSubscriptionResponse = z.infer<
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
