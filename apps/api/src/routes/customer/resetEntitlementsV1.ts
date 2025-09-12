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
  path: "/v1/customer/reset-entitlements",
  operationId: "customer.resetEntitlements",
  summary: "reset entitlements",
  description: "Reset entitlements for a customer",
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
        message: z.string().optional(),
        slugs: z.array(z.string()).optional(),
      }),
      "The result of the reset entitlements"
    ),
    ...openApiErrorResponses,
  },
})

export type ResetEntitlementsV1Request = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ResetEntitlementsV1Response = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerResetEntitlementsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")
    const { entitlement } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    const finalProjectId = key.project.workspace.isMain ? projectId : key.projectId

    // only main keys can reset entitlements for other projects other than their own
    if (key.project.workspace.isMain && projectId !== finalProjectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to reset entitlements for other projects.",
      })
    }

    // start a timer
    startTime(c, "resetEntitlements")

    // delete the customer from the DO
    const { err, val: result } = await entitlement.resetEntitlements(customerId, finalProjectId)

    // end the timer
    endTime(c, "resetEntitlements")

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
