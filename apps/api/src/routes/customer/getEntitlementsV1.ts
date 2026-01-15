import { createRoute } from "@hono/zod-openapi"
import { minimalEntitlementSchema } from "@unprice/db/validators"
import { endTime, startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/{customerId}/getEntitlements",
  operationId: "customers.getEntitlements",
  summary: "get minimal entitlements",
  description: "Get minimal entitlements for a customer",
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
      minimalEntitlementSchema.array(),
      "The result of the get minimal entitlements"
    ),
    ...openApiErrorResponses,
  },
})

export type GetEntitlementsRequest = z.infer<typeof route.request.params>
export type GetEntitlementsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetEntitlementsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId } = c.req.valid("param")
    const { usagelimiter } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getEntitlements")

    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    // validate usage from db
    const { err, val: result } = await usagelimiter.getActiveEntitlements({
      customerId,
      projectId,
      now: Date.now(),
    })

    // end the timer
    endTime(c, "getEntitlements")

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
