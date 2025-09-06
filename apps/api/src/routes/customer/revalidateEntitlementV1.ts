import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { customerEntitlementExtendedSchema } from "@unprice/db/validators"
import { endTime } from "hono/timing"
import { startTime } from "hono/timing"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/revalidate-entitlement",
  operationId: "customer.revalidateEntitlement",
  summary: "revalidate entitlement",
  description: "Revalidate entitlement for a customer",
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
      }),
      "The customer ID and feature slug to revalidate"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        success: z.boolean(),
        message: z.string().optional(),
        entitlement: customerEntitlementExtendedSchema.optional(),
      }),
      "The result of the revalidate entitlement"
    ),
    ...openApiErrorResponses,
  },
})

export type RevalidateEntitlementRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type RevalidateEntitlementResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerRevalidateEntitlementV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, featureSlug } = c.req.valid("json")
    const { entitlement } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    // start a timer
    startTime(c, "revalidateEntitlement")

    // delete the customer from the DO
    const { val: result, err } = await entitlement.revalidateEntitlement({
      customerId,
      featureSlug,
      projectId: key.projectId,
      timestamp: Date.now(),
    })

    // end the timer
    endTime(c, "revalidateEntitlement")

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
