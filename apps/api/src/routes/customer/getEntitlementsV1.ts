import { createRoute } from "@hono/zod-openapi"
import { minimalEntitlementSchema } from "@unprice/db/validators"
import { endTime, startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/getEntitlements",
  operationId: "customers.getEntitlements",
  summary: "get minimal entitlements",
  description: "Get minimal entitlements for a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        projectId: z
          .string()
          .openapi({
            description: "The project ID",
            example: "prj_1H7KQFLr7RepUyQBKdnvY",
          })
          .optional(),
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      minimalEntitlementSchema.array(),
      "The result of the get minimal entitlements"
    ),
    ...openApiErrorResponses,
  },
})

export type GetEntitlementsRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetEntitlementsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetEntitlementsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")
    const { usagelimiter } = c.get("services")
    const requestStartedAt = c.get("requestStartedAt")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getEntitlements")

    const finalProjectId = validateIsAllowedToAccessProject({
      isMain: key.project.isMain ?? false,
      key,
      requestedProjectId: projectId ?? key.project.id,
    })

    // validate usage from db
    const { err, val: result } = await usagelimiter.getActiveEntitlements({
      customerId,
      projectId: finalProjectId,
      now: requestStartedAt,
    })

    // end the timer
    endTime(c, "getEntitlements")

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
